require ('dotenv').config()//.config({ path: '.env' })

import fs from 'fs/promises'
import got from 'got'
import assert from 'assert'

import { StoreFactory } from '../Store/StoreFactory'
import { WAMessageFlow, WACompleteMessage, WAAccountInfo } from '../Internal/Constants'
import { generateJids } from './Common'
import { generateMessageID, toNumber, unixTimestampSeconds } from '@adiwajshing/baileys'
import { obfuscatedID, generateUUID } from '../Internal/Utils'

const FILES = ['./media/cat.jpeg']
const FLOWS: { [k: string]: WAMessageFlow[] } = {
    'someId': [
        { 
            id: generateMessageID(),
            name: 'some-flow',
            text: 'hello!'
        },
        { 
            id: generateMessageID(),
            name: 'some-flow-2',
            text: 'hello again!',
            image: {
                url: '',
                mimetype: 'image/jpeg'
            }
        }
    ],
    'someId2': [
        { 
            id: generateMessageID(),
            name: 'some-flow',
            text: 'hello!'
        },
        { 
            id: generateMessageID(),
            name: 'some-flow-2',
            text: 'hello wow',
            video: {
                url: '',
                mimetype: 'video/mp4'
            }
        }
    ]
}

describe ('Store', () => {
    const factory = new StoreFactory ()
    before (async () => {
        await factory.init ()
    })
    after (async () => {
        await factory.close ()
    })
    it ('should set & get media successfully', async () => {
        const store = factory.newStore ('1234')

        for (let file of FILES) {
            const buffer = await fs.readFile (file)
            
            const message_id = obfuscatedID (file, '')

            await store.setMediaMessage (message_id, buffer)

            assert.ok (await store.mediaMessageExists(message_id))

            const url = store.urlForMediaMessage (message_id)

            await got (url) // should retreive successfully
        }
    })
    it ('should set & get info', async () => {

        const INFOS: WAAccountInfo[] = [...Array(10)].map (() => (
            {
                id: generateUUID(16),
                creds: {"clientID":generateUUID(32),"serverToken": generateUUID(32), "clientToken":generateUUID(32),"encKey":generateUUID(32),"macKey":generateUUID(32)},
                lastConnect: new Date ( Math.floor(new Date().getTime() - Math.random()*1000000000) ),
                autoReconnect: Math.random() < 0.5,
                lastContactSync: Math.random() < 0.5 && new Date()
            }
        ))

        await Promise.all (
            INFOS.map (async info => {
                const store = factory.newStore (info.id)
                await store.setInfo (info)
                
                let gotInfo = await store.getInfo()
                assert.deepEqual (gotInfo.creds, info.creds)
                assert.deepEqual (
                    unixTimestampSeconds(gotInfo.lastConnect), 
                    unixTimestampSeconds(info.lastConnect)
                )
                assert.deepEqual (gotInfo.autoReconnect, info.autoReconnect)
    
                await store.setInfo (null)
                assert.ok( !(await store.getInfo()) )
    
                await store.setInfo ({ creds: info.creds, lastConnect: info.lastConnect })
                assert.deepEqual (
                    info.creds,
                    (await store.getInfo()).creds
                )
                await store.setInfo ({ autoReconnect: info.autoReconnect })
                assert.deepEqual (
                    info.autoReconnect,
                    (await store.getInfo())?.autoReconnect
                )
                gotInfo = await store.getInfo()
                
                assert.deepEqual (gotInfo.creds, info.creds)
                assert.deepEqual (
                    unixTimestampSeconds(gotInfo.lastConnect), 
                    unixTimestampSeconds(info.lastConnect)
                )
                assert.deepEqual (gotInfo.autoReconnect, info.autoReconnect)
            })
        )

        // delete credentials
        for (let info of INFOS) {
            const store = factory.newStore (info.id)
            await store.setInfo (null)
            const creds = await store.getInfo()
            assert.equal (creds, null)
        }
    })
    it ('should set & get message flows', async () => {
        for (let id in FLOWS) {
            const store = factory.newStore (id)
            for (let message of FLOWS[id]) {
                await store.messageFlowSet (message.id, message)
                message.name = "new message flow"
                await store.messageFlowSet (message.id, message) // update and see
            }
            const {flows} = await store.messageFlowsLoad(10)
            assert.deepEqual (FLOWS[id].filter (flow => !flows.find(f => f.id === flow.id)), [])
        }
        // delete flows
        for (let id in FLOWS) {
            const store = factory.newStore (id)
            for (let message of FLOWS[id]) {
                await store.messageFlowSet (message.id, null)
            }
            const {flows} = await store.messageFlowsLoad(10)
            assert.deepEqual (FLOWS[id].filter (flow => !!flows.find(f => f.id === flow.id)), [])
        }
    })
    it ('should set & get pending messages', async () => {
        const IDS = [...Array(10)].map (generateMessageID)
        const PENDING: { [k: string]: WACompleteMessage[] } = {}
        IDS.map (id => (
            PENDING[id] = [...Array(10)].map (() => (
                { 
                    key: {
                        id: generateMessageID(), 
                        remoteJid: '1244@s.whatsapp.net'
                    },
                    messageTimestamp: new Date ().getTime()/1000 + Math.random()*10000 - 5000,
                    scheduled: true
                } as WACompleteMessage
            ))
        ))

        for (let id in PENDING) {
            const store = factory.newStore (id)
            for (let message of PENDING[id]) {
                await store.pendingMessageSet (message.key.id, message)
                message.status = -1
                await store.pendingMessageSet (message.key.id, message) // update and see
            }
            const pending = await store.pendingMessagesLoad()
            assert.deepEqual (pending, PENDING[id].sort((a, b) => toNumber(a.messageTimestamp)-toNumber(b.messageTimestamp)))
        }
        // delete pending
        for (let id in PENDING) {
            const store = factory.newStore (id)
            for (let message of PENDING[id]) {
                await store.pendingMessageSet (message.key.id, null)
            }
            const pending = await store.pendingMessagesLoad()
            assert.deepEqual (pending, [])
        }
    })
    it ('should set & get notes', async () => {
        const jids = new Set<string>()
        const NOTES = {}
        const IDS = [...Array(10)].map (generateMessageID)
        IDS.forEach (id => {
            const jid = generateJids(1)[0]
            NOTES[id] = [...Array(10)].map (() => (
                { 
                    key: {id: generateMessageID(), remoteJid: jid},
                    messageTimestamp: Math.floor(Math.random()*1000)+100000,
                    note: {
                        edits: [
                            { author: 'jeff', timestamp: 1236 },
                            { author: 'jeff', timestamp: 1245 },
                            { author: 'jell', timestamp: 123 },
                        ]
                    }
                }
            ))
        })

        for (let id in NOTES) {
            const store = factory.newStore (id)

            for (let message of NOTES[id]) {
                await store.notesSet (message.key.remoteJid, message.key.id, message)
                message.status = 0
                await store.notesSet (message.key.remoteJid, message.key.id, message) // update and see
                
                if (!jids.has(message.key.remoteJid)) jids.add (message.key.remoteJid)
            }
            for (let jid of jids.values()) {
                const notes = await store.notesLoad(jid, null, null)
                assert.deepEqual (
                    notes.filter ((note, i) => i > 0 && note.messageTimestamp < notes[i-1].messageTimestamp),
                    []
                )
                assert.deepEqual (
                    notes.filter (n => n.key.remoteJid !== jid), 
                    []
                )
            }
            const notesFalse = await store.notesLoad('fake-jid', null, null)
            assert.deepEqual (notesFalse, [])
        }
        // delete notes
        for (let id in NOTES) {
            const store = factory.newStore (id)

            for (let message of NOTES[id]) {
                await store.notesSet (message.key.remoteJid, message.key.id, null)
                const notes = await store.notesLoad(message.key.remoteJid, null, null)
                assert.deepEqual (
                    notes.filter (m => m.key.id === message.key.id),
                    []
                )
            }
            for (let jid of jids.values()) {
                const notes = await store.notesLoad(jid, null, null)
                assert.deepEqual (notes, [], `expected messages to be deleted for ${jid}`)
            }
        }
    })
})