import { WAConnection as Base, BaileysEvent, DisconnectReason, ReconnectMode, BaileysError, sha256, Browsers, mediaMessageSHA256B64, WAChat, Mutex, waChatKey, WAMessageProto, Presence, delay } from '@adiwajshing/baileys'
import { Store } from '../Store/Store'
import { WAState, WACompleteMessage, WAMessageSendOptions, WAMessageSendOptionsFlow, WAFileContent, WAMessageContentInfo, WAMessageFlowEditOptions, WAMessageFlow, WAAccountInfo, PreparedChat, WACompleteChat, WACompleteContact, xmanContact } from '../Internal/Constants'
import { parseMessageOptions, Cache, fileContent } from '../Internal/Utils'
import { promises as fs } from 'fs'
import NodeCache from 'node-cache'
import * as Sentry from '@sentry/node'
import P from 'pino'
import got from "got"
import { DEFAULT_MESSAGE_PAGE_SIZE } from '../Internal/Runtypes'
import KeyedDB from '@adiwajshing/keyed-db'

const BLACKLISTED_EVENTS = new Set<string>([ 'received-pong', 'ws-close', 'credentials-updated', 'user-presence-update', 'message-update' ]) // events to not send off anywhere
const NON_EMITTING_EVENTS = new Set<string>([ 'message-new' ]) // events to not send via the EventSource
const HOOK_RETRY_CODES = [ 503, 502, 501 ] // codes on which we'll retry a hook
const LOGGER = P({ prettyPrint: process.env.PRODUCTION === 'true' ? false : { levelFirst: true, ignore: 'hostname', translateTime: true } })
LOGGER.level = process.env.LOG_LEVEL || 'info'

export class WAConnection extends Base {
    /** store to set/get data */
    store: Store
    onAnyEvent: (event: string, data: any) => void

    browserDescription = Browsers.ubuntu ('Chrome') 
    chatOrderingKey = waChatKey (true)
    loadProfilePicturesForChatsAutomatically = false
    autoReconnect = ReconnectMode.onConnectionLost
    pendingRequestTimeoutMs = 0
    contacts: { [jid: string]: WACompleteContact } = {}

    protected updatedContacts: string[] = []
    protected hasLatestChats = false
    /** current QR */
    protected currentQR: string
    /** cache flows to speed up sending them */
    protected cachedFlows = new NodeCache ({ stdTTL: 3*60*60, useClones: false, maxKeys: 30 }) // 3 hours
    // cache presence subscriptions
    protected subCache = new NodeCache({ stdTTL: 10*60, useClones: false }) // 10 mins
    protected cachedMediaUrls = new NodeCache ({ stdTTL: 3*60*60, useClones: false }) // 3 hours
    protected tagsUsed = new NodeCache ({ stdTTL: 6*60*60, useClones: false }) // 6 hours
    
    async init (store: Store, info?: WAAccountInfo) {
        this.store = store
        this.logger = LOGGER.child ({ teamId: store.teamId })
        this.store.prepareCloudWatchLogger(this.logger)

        info = info || await this.store.getInfo ()
        this.user = info?.lastKnownUser

        this.connectOptions.agent = await this.store.getAgent ()
        this.connectOptions.maxIdleTimeMs = 120_000
        this.connectOptions.alwaysUseTakeover = true

        info?.creds && this.loadAuthInfo ( info.creds )

        if (info?.creds?.encKey) {
            try {
                const data = await this.store.getWAData(this.authInfo.encKey)
                if (data) {
                    const { chats, contacts } = data
                    this.logger.info(`loaded ${chats.length} cached chats & ${Object.keys(contacts).length} contacts`)
                    this.chats = chats
                    this.contacts = contacts
                    this.lastChatsReceived = new Date()
                }
            } catch (error) {
                this.logger.info(`failed to load cached chats/contacts ${error}`)
            }
        }
        
        this
            .removeAllListeners ('qr')
            .on ('qr', qr => this.currentQR = qr)
            .on ('credentials-updated', () => {
                const info: WAAccountInfo = { id: this.store.teamId }
                info.creds = this.base64EncodedAuthInfo()
                this.store.setInfo (info)
            })
            .on ('open', ({user}) => {
                this.currentQR = null
                // store info on successful open
                store
                .setInfo ({ id: this.store.teamId, lastKnownUser: this.user, autoReconnect: true })
                .then (() => this.logger.info('updated info'))
                .then (() => this.emitPostSleepMessages ())

                this.logger = LOGGER.child ({ teamId: store.teamId, jid: user.jid })
                this.store.prepareCloudWatchLogger(this.logger)
            })
            .on ('close', ({reason}) => {
                this.currentQR = null
                this.hasLatestChats = false
                this.subCache.flushAll()

                if(reason !== DisconnectReason.invalidSession && this.authInfo?.encKey) {
                    this.store.setWAData(this.authInfo.encKey, { chats: this.chats, contacts: this.contacts })
                    .then(() => this.logger.info('closed connection, cached chats to S3'))
                    .catch(error => this.logger.error(`error in caching chats to S3 on close: ${error}`))
                }
                if (reason === DisconnectReason.invalidSession) this.onCredentialsInvalidated ()
                else if (reason !== DisconnectReason.lost) {
                    this.store.setInfo({ 
                        lastConnect: new Date(), 
                        autoReconnect: reason !== DisconnectReason.intentional && reason !== DisconnectReason.replaced
                    })
                }
            })
            .on ('chats-received', ({ hasReceivedLastMessage }) => {
                this.hasLatestChats = true
                /*console.log('here lol', hasReceivedLastMessage)
                if (hasReceivedLastMessage) {
                    this.store.setWAData(this.authInfo.encKey, { chats: this.chats, contacts: this.contacts })
                    .then(() => this.logger.info('received last message, cached chats to S3'))
                    .catch(error => this.logger.error(`error in caching chats to S3 on last chat received: ${error}`))
                }*/
            })
            .on ('received-pong', () => this.store.setInfo ({ lastConnect: new Date() }))
            .on ('contacts-received', ({ updatedContacts }) => {
                Object.values(this.contacts).forEach(c => delete c.imgUrl)
                this.updatedContacts = updatedContacts.map(({ jid }) => jid)
            })
        // connect automatically if logged in
        if (info?.autoReconnect) {
            this.connect ()
            .catch (err => this.logger.info (`error in first connect: ${err}`))
        }
        return this
    }
    canLogin () {
        return !!this.authInfo?.encKey && !!this.authInfo?.macKey
    }
    /** the current state of the connection */
    currentState (): WAState {
        return {
            connections: {
                phone: this.phoneConnected,
                waWeb: this.state
            },
            chats: {
                hasSome: !!this.lastChatsReceived,
                hasLatest: this.hasLatestChats
            },
            canLogin: this.canLogin(),
            user: this.user,
            pendingQR: this.currentQR,
            mediaUploadsUrl: this.store.urlForMediaMessage('')
        }
    }
    async connect () {
        const transaction = this.canLogin() && Sentry.startTransaction ({
            op: 'connect',
            name: 'Login to WA',
            data: {
                lastDisconnect: this.lastDisconnectReason,
                user: this.store.teamId,
                jid: this.user?.jid || 'unknown'
            }
        })
        const addClose = ({ reason }) => {
            transaction?.setData ('intermediate-closes', (transaction?.data['intermediate-closes'] || 0) + 1)
        }
        this.on ('intermediate-close', addClose)
        try {
            this.connectOptions.maxRetries = this.canLogin () ? 6 : 1
            const result = await super.connect ()
            return result
        } finally {
            this.off ('intermediate-close', addClose)
            transaction && transaction.finish ()
        }
    }
    subscribeToPresenceUpdates = async (jid: string, subscribe?: boolean) => {
        if (!this.subCache.has(jid)) {
            await this.requestPresenceUpdate(jid)
            this.subCache.set(jid, true)

            if (subscribe) {
                await this.updatePresence(jid, Presence.available)
            } 
        }
    }
    async relayWAMessage (message: WACompleteMessage, { waitForAck } = { waitForAck: true }) {
        if (message.withTyping) {
            const jid = message.key.remoteJid

            if (this.chats.get(jid)) {
                await this.chatRead (jid, 'read')
            }
            
            await this.updatePresence (jid, Presence.available)
            await delay (500)

            const fKey = message.message && Object.keys (message.message)[0]
            const obj = message.message && message.message[fKey]
            if (typeof obj === 'string' || obj?.text || obj?.caption) {
                await this.updatePresence (jid, Presence.composing)
                await delay ( Math.random()*5000 + 1000 )
            }   
        }
        const transaction = Sentry.startTransaction ({
            op: 'send-message',
            name: 'Send Message',
            data: {
                teamId: this.store.teamId,
                sender: this.user?.jid
            }
        })
        try {
            await (
                super.relayWAMessage (message, { waitForAck })
                .catch (err => {
                    this.logger.debug({ message, trace: err?.stack?.toString() }, `error while sending message: ${err}`)
                    throw err
                })
            )
        } finally {
            transaction.finish ()
        }
    }
    /** Get messages received while the connection was offline */
    async emitPostSleepMessages () {
        const date = (await this.store.getInfo ())?.lastConnect // last connect time
        if (!date) return 
        
        const messages = await this.messagesReceivedAfter(date, true) // get all messages after
        this.logger.info (`connected after ${ (new Date().getTime()-date.getTime())/1000 }s, got ${messages.length} messages`)
        this.emit('messages-post-sleep' as BaileysEvent, messages)

        await this.store.setInfo ({ lastConnect: new Date() }) // save connect time
    }
    /** Loads all kinds of messages -- notes, scheduled etc. */
    async loadMessagesAllKinds (jid: string, count: number, before?: string): Promise<{messages: WACompleteMessage[], cursor: string}> {
        const parsedCursor = before && JSON.parse (before)
        const { messages, cursor } = await this.loadMessages (jid, count, parsedCursor, true)
        return { messages, cursor: JSON.stringify(cursor) }
    }
    /** url for a media message */
    @Cache ((jid, messageID) => (jid+messageID), 'cachedMediaUrls' as keyof WAConnection)
    async mediaMessageUrl (jid: string, messageID: string) {
        const message = await this.loadMessage (jid, messageID)
        if (!message || !message.message) throw new BaileysError ('not found', { status: 404 })

        const fileSHA = mediaMessageSHA256B64 (message.message)
        if (!fileSHA) throw new BaileysError ('invalid message', { status: 400 })

        const exists = await this.store.mediaMessageExists (fileSHA)
        if (!exists) {
            this.logger.info (`downloading media for ${messageID}`)
            const content = await this.downloadMediaMessage (message)
            await this.store.setMediaMessage (fileSHA, content)
        }
        return this.store.urlForMediaMessage (fileSHA)
    }
    @Mutex(jid => jid)
    async cachedProfilePicture(jid: string) {
        let imgUrl: string
        const contact = this.contacts[jid]
        if (typeof contact?.imgUrl !== 'undefined') {
            imgUrl = contact.imgUrl
        } else {
            imgUrl = await (
                this.getProfilePicture (jid)
                .catch(error => {
                    if (error.status === 428) throw error
                    return ''
                })
            )
            if(contact) contact.imgUrl = imgUrl
            
            const chat = this.chats.get(jid)
            if (chat) chat.imgUrl = imgUrl
        }
        return imgUrl
    }
    /**
     * Loads the message content from a message flow
     * @param flowId 
     */
    @Cache (flowId => flowId, 'cachedFlows')
    async prepareMessageContentFromSendOptionsFlow (flowId: string) {
        const flow = await this.store.messageFlowGet (flowId)
        const {message, type, options} = await parseMessageOptions (flow)
        const content = await this.prepareMessageContent (message, type, options)
        return {content, options} as WAMessageContentInfo
    }
    async prepareMessageFromSendOptionsFlow (mOptions: WAMessageSendOptionsFlow) {
        let info = await this.prepareMessageContentFromSendOptionsFlow (mOptions.flow)
        if (mOptions.parameters || mOptions.randomizeMessage) {
            info = { 
                options: info.options, 
                content: WAMessageProto.Message.toObject(info.content as WAMessageProto.Message) 
            }
            // automatic name detection
            let name: string
            const recp = this.contacts[mOptions.jid]
            if (recp) {
                name = recp.profile?.name || recp.name || recp.notify || recp.vname || ''
                const fName = name.split (' ')[0]
                mOptions.parameters = { ...{ recipient: name, 'recipient-first': fName }, ...(mOptions.parameters || {}) }
            }
            const key = Object.keys(info.content)[0]
            let text: string = info.content[key].text || info.content[key].caption
            
            if (mOptions.randomizeMessage?.toString() === 'true') {
                // randomly add spaces
                text = (text || ' ').replace (/ /g, () => (
                    Math.random() < 0.75 ? 
                    ' ' :  
                    [...Array(Math.floor(Math.random()*4) + 1)]
                    .map (() => ' ')
                    .join ('')
                ))
            }

            if (text) {
                Object.keys(mOptions.parameters || {}).forEach (key => (
                    text = text.replace (new RegExp(`\{${key}\}`, 'g'), mOptions.parameters[key])
                ))

                if (info.content[key].text) info.content[key].text = text
                else info.content[key].caption = text
            }
            info.content = WAMessageProto.Message.fromObject (info.content)
        }
        const prepped = await this.prepareMessageFromContentInfo (mOptions, info)
        return prepped
    }
    async prepareMessageFromSendOptions (mOptions: WAMessageSendOptions) {
        const {message, type, options} = await parseMessageOptions (mOptions)
        const content = await this.prepareMessageContent (message, type, options)
        const prepped = await this.prepareMessageFromContentInfo (mOptions, { content, options })
        return prepped
    }
    async prepareMessageFromContentInfo (mOptions: { quotedID?: string, scheduleAt?: string | number, jid: string, tag?: string, withTyping?: any }, {content, options}: WAMessageContentInfo) {
        if (mOptions.tag) {
            if (this.tagsUsed.has(mOptions.tag)) {
                throw new BaileysError('tag already used', { status: 409 })
            }
        }
        if(mOptions.jid.endsWith('@s.whatsapp.net')) {
            const fJid = mOptions.jid.replace ('@s.whatsapp.net', '').replace (/[^0-9]/g, '') + '@s.whatsapp.net'
            if (fJid !== mOptions.jid) {
                this.logger.warn ({ original: mOptions.jid, corrected: fJid }, 'received incorrectly formatted jid')
                if (fJid === '@s.whatsapp.net') throw new BaileysError (`Received oddly formatted jid: ${mOptions.jid}`, { status: 400 })
            }
            mOptions.jid = fJid
            if (!this.chats.get(mOptions.jid)) {
                const {jid} = await this.assertOnWhatsApp(mOptions.jid)
                mOptions.jid = jid
            }
        }
        if (mOptions.quotedID) {
            await this.waitForConnection ()
            options.quoted = await this.loadMessage (mOptions.jid, mOptions.quotedID)
        }
        if (mOptions.scheduleAt) {
            const stamp = new Date (Math.round(+mOptions.scheduleAt)*1000)
            options.timestamp = stamp
        } else delete options.timestamp

        let prepared = this.prepareMessageFromContent (mOptions.jid, content, options) as WACompleteMessage
        prepared = WAMessageProto.WebMessageInfo.toObject(prepared) as WACompleteMessage
        
        if (mOptions.scheduleAt) prepared.scheduled = true
        if (mOptions.withTyping) prepared.withTyping = true
        if (mOptions.tag) {
            prepared.tag = mOptions.tag
            this.tagsUsed.set(mOptions.tag, true)
        }
        
        return prepared
    }
    async uploadToS3IfRequired (file: WAFileContent) {
        if (file && !file.url.startsWith('http')) {
            // upload the file if not a url
            const buffer = await fs.readFile (file.url)
            const fileSHA = sha256 (buffer).toString ('base64')
            await this.store.setMediaMessage (fileSHA, buffer)
            file.url = this.store.urlForMediaMessage (fileSHA)
        }
    }
    async deleteMessageFlow (flow: string) {
        await this.store.messageFlowSet (flow, null)
        this.cachedFlows.del (flow)
    }
    async editMessageFlow (options: WAMessageFlowEditOptions) {
        let flow = await this.store.messageFlowGet (options.id)
        
        fileContent(options) && await this.uploadToS3IfRequired (fileContent(options))
        if (!options.name) options.name = flow.name
        
        await this.store.messageFlowSet (options.id, options as any)
        
        this.cachedFlows.del (flow.id)
        return options as WAMessageFlow
    }
    async logout () {
        await this.onCredentialsInvalidated ()
        await super.logout ()

        this.emit ('state-sync', this.currentState())
    }
    async prepareChatsForSending (chats: WAChat[]) {
        const preppedChats = chats.map(chat => {
            // get last X messages
            const messages = chat.messages.all().slice(-DEFAULT_MESSAGE_PAGE_SIZE)
            return { ...chat, messages }
        })
        return preppedChats as PreparedChat[]
    }
    @Mutex(jid => jid)
    async assertOnWhatsApp (str: string) {
        str = str.split('@')[0]
        const exists = await this.isOnWhatsApp (`${Math.abs(+str)}@s.whatsapp.net`)
        if (exists) return exists
        throw new BaileysError('Not on WhatsApp', { status: 404 })
    }
    assertChatGet = (jid: string) => {
        const chat = this.chats.get (jid)
        if (!chat) throw new BaileysError ('not found', { status: 404 })
        return chat
    }
    emit (event: BaileysEvent | string, ...args: any[]) {
        if (event === 'chats-received' && !args[0].hasReceivedLastMessage) {
            const chats = []//this.chats.slice(0, DEFAULT_CHAT_PAGE_SIZE).all().map(c => this.prepareChatsForSending(c)) 
            args[0] = { 
                ...args[0], 
                chatsPage: {
                    chats,
                    cursor: chats.length > 0 && this.chatOrderingKey.key(chats[chats.length-1])
                }
            }
        }
        if(!event.startsWith('TAG:') && !event.startsWith('CB:') && !BLACKLISTED_EVENTS.has(event)) {
            this.fireWebHooks (event, args[0])
            if (!NON_EMITTING_EVENTS.has(event)) {
                this.logger.trace(`emitting: ${event}`)
                this.onAnyEvent (event, args[0])
            }
        }
        return super.emit (event, ...args)
    }
    end () {
        this.closeInternal ('end' as DisconnectReason, false)
    }

    protected async fireWebHooks (event: string, data: any) {
        const hooks = await this.store.webhooks (event)
        if (hooks.length <= 0) return

        try {
            const token = await this.store.getAuthToken ()
            const results = await Promise.allSettled (
                hooks.map (hook => (
                    got.post (hook, { 
                        method: 'POST', 
                        body: JSON.stringify({ event, data }), 
                        headers: { 
                            ['content-type']: 'application/json',
                            'authorization': `Bearer ${token}`
                        },
                        retry: {
                            limit: 5,
                            statusCodes: HOOK_RETRY_CODES
                        }
                    })
                    .catch(error => {
                        this.logger.debug({ error, hook }, `error in '${event}' hook at ${hook}: ${error.message}`)
                        throw error
                    })
                ))
            )
            const successes = results.reduce ((s, value) => value.status === 'fulfilled' ? s + 1 : s, 0)
            this.logger.debug ({ hooks: hooks.length, successes, event }, `completed hook for ${event}`)
        } catch (error) {
            this.logger.error({ error }, `error in firing webhooks: ${error}`)
            Sentry.captureException(error)
        }
    }
    contactsCleaned (onlyUpdated: boolean) {
        const arr = [ ]
        const keys = onlyUpdated ? this.updatedContacts : Object.keys(this.contacts)
        for (let jid of keys) {
            if (!jid.endsWith('@s.whatsapp.net')) continue // exclude non-single chats
            const contact = this.contacts[jid]
            const obj = {
                phone: contact.jid.split('@')[0]
            }
            const name = contact.name || contact.notify || contact.vname || undefined
            if (name) obj['name'] = name
            
            const chatObj = this.chats.get(contact.jid)
            if (chatObj) {
                obj['messagesSent'] = chatObj.messages.filter(m => !!m.message && m.key.fromMe).length
                obj['messagesReceived'] = chatObj.messages.filter(m => !!m.message && !m.key.fromMe).length
            }
            arr.push (obj)
        }
        return arr as xmanContact[]
    }
    async getNewMediaConn () {
        const mediaConn = await super.getNewMediaConn ()
        mediaConn.hosts = [
            { 
                // AWS gateway url, proxies the data being sent, so we don't get blocked
                hostname: 'rdc6el5bd2.execute-api.ap-east-1.amazonaws.com/testing'
            },
            {
                hostname: mediaConn.hosts[0].hostname
            },
        ]
        return mediaConn
    }
    /** clear out all credentials */
    protected async onCredentialsInvalidated () {
        this.authInfo = undefined
        this.lastChatsReceived = undefined

        await this.store.setInfo (undefined)
    }
}