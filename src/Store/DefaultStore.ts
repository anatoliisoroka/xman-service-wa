import { unixTimestampSeconds, BaileysError, toNumber, WAChat, aesEncrypt, aesDecrypt, waChatKey, newMessagesDB, Mutex } from '@adiwajshing/baileys'

import { WACompleteMessage, WAMessageFlow, WAMessageFlowCreateOptions, WAAccountInfo, xman_SERVICE_ID, WAData } from '../Internal/Constants'
import { sqlDecodeMessage, sqlEncodeMessage } from '../Internal/Utils'
import { StoreFactory } from './StoreFactory'
import { Store } from './Store'
import KeyedDB from '@adiwajshing/keyed-db'
import got from 'got/dist/source'
import { URL } from 'url'
import { DEFAULT_CHAT_PAGE_SIZE } from '../Internal/Runtypes'

export class DefaultStore implements Store {
    teamId: string
    serviceId: string

    options: StoreFactory
    s3DataKey: string

    async init (id: string) {
        this.teamId = id
        this.s3DataKey = `wa-cache/${this.teamId}.json`
        this.serviceId = xman_SERVICE_ID
    }

    prepareCloudWatchLogger = (logger) => this.options.prepareCloudWatchLogger(this.teamId, logger)
    
    async setWAData (key: Buffer, {chats, contacts}: WAData) {
        const serialized = JSON.stringify(
            {
                chats: chats.all().map (chat => ({ ...chat, messages: chat.messages.slice(DEFAULT_CHAT_PAGE_SIZE, undefined), presences: undefined })),
                contacts
            }
        )
        const enc = aesEncrypt(Buffer.from(serialized), key)
        await this.options.s3PutObject(`wa-cache/${this.teamId}.json`, enc)
    }
    async getWAData (key: Buffer) {
        const exists = await this.options.s3FileExists(this.s3DataKey)
        if (exists) {
            const downloaded = await got.get( new URL(this.s3DataKey, this.bucketUrl()) )
            const decrypted = aesDecrypt(downloaded.rawBody, key)
            const serialized = decrypted.toString('utf-8')
            const data: WAData | WAChat[] = JSON.parse(serialized)
            
            const db = new KeyedDB(waChatKey(true), c => c.jid)
            const chats = Array.isArray(data) ? data : data.chats as any as WAChat[]
            const contacts = Array.isArray(data) ? {} : data.contacts
            chats?.forEach(item => {
                try {
                    item.messages = newMessagesDB(
                        (item.messages as any as any[]).map((m, i) => { m.epoch = i; return m })
                    )
                    db.insert(item)
                } catch {}
            })
            return { chats: db, contacts }
        }
    }

    async getAuthToken (): Promise<string> {
        return this.options.auth.getToken (this.teamId)
    }
    async mediaMessageExists (messageID: string) {
        const exists = await this.options.s3FileExists (messageID)
        return exists
    }
    async webhooks (event: string) {
        await this.options.loadWebHooksIfRequired (this.serviceId) 
        
        const hooks = [ ...(this.options.webhooks[this.serviceId][''] || []) ]
        hooks.push (...(this.options.webhooks[this.serviceId][event] || []))

        return hooks
    }
    @Mutex()
    async fetchContacts (contacts: string[]) {
        return this.options.audience.fetchContacts(this.teamId, { contacts })
    }
    async getAgent () {
        return this.options.proxy.getAgent ()
    }
    async setMediaMessage (messageID: string, content: Buffer) {
        await this.options.s3PutObject (messageID, content)
    }
    bucketUrl () {
        return `https://${this.options['bucket']}.s3.${this.options.s3Region}.amazonaws.com`
    }
    urlForMediaMessage (messageID: string) {
        return new URL(encodeURIComponent(messageID), this.bucketUrl()).toString()
    }
    async messageFlowSet (id: string, flow: WAMessageFlow | WAMessageFlowCreateOptions | null) {
        if (flow && !('id' in flow)) {
            flow['id'] = id
            flow = flow as WAMessageFlow
        }
        if (!flow) {
            await this.options.query (`DELETE FROM MessageFlows WHERE id='${id}' AND user_id='${this.teamId}' LIMIT 1`)
        } else {
            let found = false
            await this.options.query (`SELECT COUNT(*) AS count FROM MessageFlows WHERE user_id='${this.teamId}' AND id='${id}'`, row => (
                found = parseInt(row.count) > 0
            ))
            const time = `FROM_UNIXTIME(${unixTimestampSeconds()})`
            const encoded = sqlEncodeMessage(flow)
            if (found) await this.options.query (`UPDATE MessageFlows SET name='${flow.name}', flow=${encoded}, last_updated=${time} WHERE user_id='${this.teamId}' AND id='${id}'`)
            else await this.options.query (`INSERT INTO MessageFlows VALUES('${id}', '${flow.name}', '${this.teamId}', ${encoded}, ${time})`)
        }
        return flow as WAMessageFlow
    }
    async messageFlowGet (id: string) {
        let result: WAMessageFlow
        await this.options.query (`SELECT flow FROM MessageFlows WHERE id='${id}' AND user_id='${this.teamId}' LIMIT 1`, row => {
            result = sqlDecodeMessage (row.flow)
        })
        if (!result) throw new BaileysError ('not found', { status: 404 })
        return result
    }
    async messageFlowsLoad (count: number, cursor?: string, searchString?: string) {
        let flows: WAMessageFlow[] = []
        const [name, id] = (cursor || '').split(':')
        const cursorClause = !!name && !!id ? ` AND (name, id) > ('${name}', '${id}')` : ''
        const searchClause = searchString ? ` AND name LIKE '%${searchString}%'` : ''

        await this.options.query (`SELECT flow FROM MessageFlows WHERE user_id='${this.teamId}'${cursorClause}${searchClause} ORDER BY name, id LIMIT ${count}`, row => (
            flows.push(sqlDecodeMessage (row.flow))
        ))
        if (flows.length > 0) cursor = flows[flows.length-1].name + ':' + flows[flows.length-1].id
        else cursor = undefined

        return {flows, cursor}
    }
    async setInfo (info?: Partial<WAAccountInfo>) {
        if (!info) {
            await this.options.query (`DELETE FROM Credentials WHERE id='${this.teamId}' LIMIT 1`)
        } else {
            const date = info.lastConnect && `FROM_UNIXTIME(${unixTimestampSeconds(info.lastConnect)})`
            const creds = info.creds && `'${JSON.stringify(info.creds)}'`
            const autoConnect = typeof info.autoReconnect !== 'undefined' && `'${ info.autoReconnect ? 1 : 0 }'`
            const user = typeof info.lastKnownUser !== 'undefined' && `x'${Buffer.from(JSON.stringify(info.lastKnownUser)).toString('hex')}'`

            const updates = []
            if (date) updates.push (`last_connect=${date}`)
            if (creds) updates.push (`cred=${creds}`)
            if (autoConnect) updates.push (`auto_connect=${autoConnect}`)
            if (user) updates.push (`last_known_user=${user}`)
            await this.options.query (
                `
                    INSERT INTO Credentials (id, cred, last_connect, auto_connect, last_known_user) VALUES('${this.teamId}', ${creds || '\'\''}, ${date || 'NULL'}, ${ autoConnect || 'NULL' }, ${ user || 'NULL' })
                    ON DUPLICATE KEY UPDATE ${
                        updates.join (', ')
                    }
                `
            )
        }
    }
    async getInfo () {
        const accounts = await this.options.accountsQuery (`id='${this.teamId}' LIMIT 1`)
        return accounts[0]
    }
    
    async pendingMessagesLoad () {
        const results: WACompleteMessage[] = []
        await this.options.query (`SELECT message FROM PendingMessages WHERE user_id='${this.teamId}' ORDER BY timestamp`, row => results.push(sqlDecodeMessage(row.message as any)))
        return results
    }
    async pendingMessageSet (messageID: string, message: WACompleteMessage | null) {
        await this.messageSetInternal (messageID, message, 'PendingMessages')       
    }

    async notesLoad (chats: {jid: string, before: number | null, till: number | null}[]) {
        const results: { [jid: string]: WACompleteMessage[] } = {}
        if (chats.length > 0) {
            const whereClause = chats.map (({ jid, before, till }) => {
                const beforeClause = before ? ` AND notes.timestamp <= FROM_UNIXTIME(${before})` : ''
                const tillClause = till ? ` AND notes.timestamp > FROM_UNIXTIME(${till})` : ''
                const whereClause = `notes.chat_id='${jid}' ${beforeClause} ${tillClause}`
    
                return `(${whereClause})`
            })
            .join(' OR ')
            
            await this.options.query (`SELECT message FROM notes WHERE (${whereClause}) AND notes.user_id='${this.teamId}' ORDER BY chat_id, timestamp`, row => {
                const m = sqlDecodeMessage(row.message) as WACompleteMessage
                
                if (!results[m.key.remoteJid]) results[m.key.remoteJid] = []
                results[m.key.remoteJid].push (m)
            })
        }
        return results
    }
    async notesGet (jid: string, noteID: string) {
        let result: WACompleteMessage
        await this.options.query (`SELECT message FROM notes WHERE user_id='${this.teamId}' AND message_id='${noteID}'`, row => {
            const m = sqlDecodeMessage(row.message) as WACompleteMessage
            result = m
        })
        return result
    }
    async notesSet (jid: string, noteID: string, note: WACompleteMessage | null) {
        await this.messageSetInternal (noteID, note, 'notes') 
    }

    private async messageSetInternal (messageID: string, message: WACompleteMessage | null, table: string) {
        if (message) {
            const serialized = sqlEncodeMessage(message)
            const timestamp = +toNumber (message.messageTimestamp)
            
            const jid = message.key.remoteJid
            let found = false
            await this.options.query (`SELECT COUNT(*) AS count FROM ${table} WHERE user_id='${this.teamId}' AND message_id='${messageID}'`, row => (
                found = parseInt(row.count) > 0
            ))
            if (found) await this.options.query (`UPDATE ${table} SET message=${serialized}, timestamp=FROM_UNIXTIME(${timestamp}) WHERE user_id='${this.teamId}' AND message_id='${messageID}'`)
            else await this.options.query (`INSERT INTO ${table} VALUES('${this.teamId}','${jid}','${messageID}', FROM_UNIXTIME(${timestamp}), ${serialized})`)
        } else {
            await this.options.query (`DELETE FROM ${table} WHERE user_id='${this.teamId}' AND message_id='${messageID}'`)
        }        
    }
    protected log (txt: any) {
        console.log (txt)
    }
}