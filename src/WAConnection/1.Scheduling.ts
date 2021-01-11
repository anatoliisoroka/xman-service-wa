import { whatsappID, WA_MESSAGE_STATUS_TYPE, BaileysError, WA_MESSAGE_STUB_TYPE, delayCancellable, WAMessageKey, toNumber, newMessagesDB, WAChat } from '@adiwajshing/baileys'
import KeyedDB from '@adiwajshing/keyed-db'
import { Store } from '../Store/Store'
import { WACompleteMessage, WAAccountInfo } from '../Internal/Constants'
import { pendingMessageDB } from '../Internal/Utils'
import { WAConnection as Base } from './0.Base'

export class WAConnection extends Base {
    protected messageQueue: { [k: string]: KeyedDB<WACompleteMessage, number> } = {}
    protected scheduledMessages: { [k: string]: {message: WACompleteMessage, cancel: () => void} } = {}
    
    async init (store: Store, info?: WAAccountInfo) {
        await super.init (store, info)

        await (
            this.loadPendingMessages()
            .catch (err => this.logger.error(`error in loading pending messages`, err))
        )

        this
        .on ('open', () => {
            this.scheduleMessagesRequired ()
        })
        .on ('close', () => {
            // deschedule messages
            Object.values(this.scheduledMessages).forEach (value => value.cancel())
            this.scheduledMessages = {}
        })

        return this
    }
    // add scheduled messages to all messages
    async loadMessagesAllKinds (jid: string, count: number, before?: string) {
        jid = whatsappID (jid)
        let {messages, cursor} = await super.loadMessagesAllKinds (jid, count, before)
        if (!before && this.messageQueue[jid]) {
            messages = [...messages, ...this.messageQueue[jid].all()]
        }
        return {messages, cursor}
    }
    async relayWAMessage (message: WACompleteMessage, { waitForAck } = { waitForAck: true }) {
        if (message.scheduled) {
            this.logger.debug ('scheduled message: ' + message.key.id + ' to ' + message.key.remoteJid)

            await this.insertMessage (message, true)
            if (this.state === 'open') {
                this.descheduleMessages (message.key.remoteJid)
                this.scheduleFirstMessage (message.key.remoteJid)   
            }
            this.emit ('chat-update', { jid: message.key.remoteJid, messages: newMessagesDB([ message ]) })
        } else {
            await super.relayWAMessage (message, {waitForAck})
        }
    }
    async deleteAllScheduledMessage (jid: string) {     
        this.logger.info ('clearing all scheduled messages for ' + jid)
        if (this.state === 'open') this.descheduleMessages (jid)

        const db = this.messageQueue[jid]
        if (db) {
            await Promise.all (
                db.all ()
                .map (m => (
                    this.store.pendingMessageSet (m.key.id, null)
                ))
            )
        }
        delete this.messageQueue[jid]
        
    }
    async deleteMessage (jid: string, key: WAMessageKey) {        
        let message: WACompleteMessage
        // if it's a pending message -- remove it
        if (this.messageQueue[jid]?.get(key.id)) {
            message = await this.deleteScheduledMessage (jid, key.id)
        } else {
            this.assertChatGet (jid)
            message = await super.deleteMessage (jid, key)
        }
        return message
    }
    async deleteChat (jid: string) {
        jid = whatsappID(jid)
        const response = await super.deleteChat (jid)
        
        const db = this.messageQueue[jid]
        if (db) {
            // delete any scheduled messages along with the chats
            this.descheduleMessages (jid)
            delete this.messageQueue[jid]
        }
        return response
    }
    async rescheduleMessage (jid: string, messageID: string, timestamp: number) {
        if (this.state === 'open') this.descheduleMessages (jid)

        this.logger.debug (`rescheduling message: ${messageID}`)

        const db = this.messageQueue[jid]
        const message = db?.get (messageID)
        
        message.status = WA_MESSAGE_STATUS_TYPE.PENDING
        db.updateKey (message, m => m.messageTimestamp = timestamp)

        await this.store.pendingMessageSet (messageID, message)
        this.emit ('chat-update', { jid, messages: newMessagesDB([ message ]) })

        if (this.state === 'open') {
            this.scheduleFirstMessage (jid)
        }
    }

    async prepareChatsForSending (chats: WAChat[]) {
        const prepped = await super.prepareChatsForSending(chats)
        prepped.forEach(chat => this.messageQueue[chat.jid] && chat.messages.push(...this.messageQueue[chat.jid].all()))
        return prepped
    }

    // internal functions ---------------------

    protected scheduleMessagesRequired () {
        this.logger.info ('scheduling messages')
        
        Object.keys (this.messageQueue)
        .forEach (jid => this.scheduleFirstMessage(jid))
    }
    protected scheduleFirstMessage (jid: string) {
        const db = this.messageQueue[jid]
        if (db && db.length > 0) {
            !this.scheduledMessages[jid] && 
            this.scheduleMessage (db.all()[0])
        }
    }
    protected async loadPendingMessages () {
        this.logger.debug ('loading pending messages')

        const pending = await this.store.pendingMessagesLoad () 

        this.logger.info ({ length: pending.length }, 'loaded pending messages')
        
        this.messageQueue = {}
        pending.forEach (m => this.insertMessage(m, false))
    }
    protected async scheduleMessage (message: WACompleteMessage) {
        const jid = whatsappID (message.key.remoteJid)
        const key = message.key.id
        const stamp = toNumber( message.messageTimestamp )
        const timestamp = new Date(stamp*1000)
        
        // update or add chat
        let chat = this.chats.get (jid) 
        if (!chat) chat = await this.chatAdd (jid)
        else if (chat.t < stamp) this.chats.updateKey (chat, c => c.t = stamp)
        
        // marked as scheduled message
        message.scheduled = true
        
        if (!this.messageQueue[jid]) this.messageQueue[jid] = pendingMessageDB ()
        if (!this.messageQueue[jid].get(key)) this.messageQueue[jid].insert(message)
        
        this.logger.info (`scheduled message to ${jid} at ${timestamp}`)

        const {delay, cancel} = delayCancellable (timestamp.getTime() - new Date().getTime())

        const execute = async () => {
            await delay

            try {
                delete message.scheduled
                await this.relayWAMessage (message, { waitForAck: true })
                // update status
                message.status = WA_MESSAGE_STATUS_TYPE.SERVER_ACK
                this.messageQueue[jid]?.delete (message)
                await this.store.pendingMessageSet (key, null)

                delete this.scheduledMessages[jid]

                this.logger.debug ({ key, jid }, `sent scheduled message ${key} to ${jid}`)

                this.scheduleFirstMessage (jid)
            } catch (error) {
                if (error instanceof BaileysError) {
                    this.logger.error ({error}, `error in sending scheduled message`)
                    
                    message.status = -1
                    message.scheduled = true

                    await this.store.pendingMessageSet (key, message)

                    this.emit ('chat-update', { jid, messages: newMessagesDB([ message ]) })
                }
            }
        }
        execute ()
        .catch (err => {
            if (err.message !== 'cancelled') throw err
            else this.logger.debug ('descheduled message for ' + jid)
        })
        this.scheduledMessages[ jid ] = { message, cancel }
    }
    protected async insertMessage (m: WACompleteMessage, insertInDB: boolean) {
        const jid = whatsappID (m.key.remoteJid)
        this.messageQueue[jid] = this.messageQueue[jid] || pendingMessageDB ()
        this.messageQueue[jid].insert (m)

        insertInDB && (
            await this.store.pendingMessageSet (m.key.id, m)
        )
    }
    protected descheduleMessages (jid: string) {
        if (this.scheduledMessages[jid]) {
            this.scheduledMessages[jid].cancel()
            delete this.scheduledMessages[jid]
        }
    }
    protected async deleteScheduledMessage (jid: string, messageID: string) {
        const db = this.messageQueue[jid]
        if (db) {
            this.logger.info (`stopping scheduled messages: ${jid}`)
            this.descheduleMessages (jid) // deschedule
        
            const message = db.get (messageID)
            db.delete (message)
            
            delete message.message
            message.messageStubType = WA_MESSAGE_STUB_TYPE.REVOKE
            
            await this.store.pendingMessageSet (messageID, null)
            this.emit ('chat-update', { jid, messages: newMessagesDB([ message ]) })

            if (this.state === 'open') {
                this.scheduleFirstMessage (jid)
            }

            return message
        } else {
            this.logger.warn (`pending messages unexpectedly db absent for: ${jid}`)   
            throw new BaileysError ('pending messages not found', { status: 404 })
        }
    }
}