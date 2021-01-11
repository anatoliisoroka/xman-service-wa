import Crypto from 'crypto'
import { MessageOptions, WATextMessage, WALocationMessage, MessageType, Mimetype, WAContact, isGroupID } from '@adiwajshing/baileys'
import KeyedDB from '@adiwajshing/keyed-db'
import { S3 } from 'aws-sdk'
import msgpack from 'msgpack-lite'
import { Static } from 'runtypes'
import got from 'got'
import NodeCache from 'node-cache'

import { WACompleteMessage } from './Constants'
import { HTTPError } from '../App'
import { promises as fs } from 'fs'
import { DirectMessageOptions } from './Runtypes'

function hashCode(s: string) {
    for(var i = 0, h = 0; i < s.length; i++)
        h = Math.imul(31, h) + s.charCodeAt(i) | 0;
    return h;
}
export const randomNumber = (min, max) => Math.random() * (max - min) + min
export const generateUUID = (length: number) => Crypto.randomBytes (length/2).toString ('hex')
export const obfuscatedID = (mID: string, jid: string) => Crypto.createHash ('sha3-256').update (jid + '-' + mID).digest('hex')

export function pendingMessageDB <M extends WACompleteMessage> () {
    return new KeyedDB<M, number> (
      {
        key: m => (m.messageTimestamp as number)*10000 + (hashCode(m.key.id)%10000),
        compare: (a, b) => a-b
      }, 
      m => m.key.id
    )
}
export const mergeSortedArrays = function <T>(arr1: T[], arr2: T[], compare: (a: T, b: T) => number) {
    const result: T[] = []
    let i = 0
    let j = 0
    while( i < arr1.length && j < arr2.length ){
      if(compare(arr1[i], arr2[j]) <= 0) result.push(arr1[i++])
      else result.push(arr2[j++]) 
    }
    return result.concat(arr1.slice(i)).concat(arr2.slice(j))
}

export const s3BucketExists = async (s3: S3, bucket: string) => { 
  try {
    await s3.headBucket({Bucket: bucket}).promise()
    return true
  } catch (error) {
    if (error.statusCode === 404) return false
    throw error;
  }
}
export const s3FileExists = async (s3: S3, bucket: string, file: string) => { 
  try {
    await s3.headObject({Bucket: bucket, Key: file}).promise()
    return true
  } catch (error) {
    if (error.code === 'NotFound') return false
    throw error;
  }
}
export const sqlEncodeMessage = (message: any) => `x'${msgpack.encode(message).toString('hex')}'`
export const sqlDecodeMessage = (buff: Buffer) => msgpack.decode(buff)

export const downloadedFile = async (url: string) => {
  const isHTTP = url.startsWith ('https://') || url.startsWith ('http://')
  if (isHTTP) {
    const response = await got.get (url)
    return response.rawBody
  }
  if (!url.startsWith('tmp/')) throw new HTTPError ('Invalid url', 403)
  const content = await fs.readFile (url)
  await fs.unlink (url)
  return content
}
/** extract file content from a message */
export const fileContent = (options: Static<typeof DirectMessageOptions>) => options.image || options.video || options.sticker || options.document || options.audio 
export const parseMessageOptions = async (options: Static<typeof DirectMessageOptions>) => {
  let message: Buffer | WATextMessage | WALocationMessage
  let messageType: MessageType
  
  const messageOptions: MessageOptions = { }
  const file = fileContent (options)
  
  if (options.location) {
    message = { degreesLatitude: options.location.degreesLatitude, degreesLongitude: options.location.degreesLongitude }
    messageType = MessageType.location
  } else if (file) {
    messageOptions.caption = options.text
    messageOptions.mimetype = file.mimetype
    messageOptions.filename = file.name
    messageOptions.ptt = options.pttAudio === 'true' || options.pttAudio === true
    if (options.gifVideo) {
      messageOptions.mimetype = Mimetype.gif
    }
    
    messageType = options.image ? MessageType.image : 
                  options.video ? MessageType.video : 
                  options.sticker ? MessageType.sticker : 
                  options.document ? MessageType.document : MessageType.audio

    message = await downloadedFile(file.url)
  } else {
    messageType = MessageType.extendedText
    message = { text: options.text } as WATextMessage
  }

  return {message, type: messageType, options: messageOptions}
}
export function Cache<T>(keyGetter: (this: T, ...args: any[]) => string, cacheProperty: keyof T) {
  return function (_, __, descriptor: PropertyDescriptor) {
    const originalMethod = descriptor.value
    descriptor.value = async function (this: T, ...args) {
        const cache = this[cacheProperty] as any as NodeCache
        const key = (keyGetter && keyGetter.call(this, ...args)) || 'undefined'
        let value = cache.get (key)
        
        if (!value) {
          value = await originalMethod.call (this, ...args)
          cache.set (key, value)
        }
        return value
    }
  }
}