require ('dotenv').config()

import { promises as fs } from 'fs'
import { WAConnection } from './WAConnection/WAConnection'
import { App, CacheControl, HTTPError } from './App'
import { StoreFactory } from './Store/StoreFactory'
import SlowDown from 'express-slow-down'
import { ChatGetsOptions, DEFAULT_CHAT_PAGE_SIZE, NoteDeleteOptions, MessageGetsOptions, ChatPresenceSubscription, ChatTypingOptions, ChatModificationOptions, ChatReadOptions, UserStatusUpdateRequest, ChatPictureUpdateOptions, MessageDeleteOptions, MessageComposeOptions, NoteComposeOptions, MessageReschedulingOptions, NoteEditOptions, GroupCreateOptions, GroupRetreivalOptions, MessageGetOptions, GroupModificationOptions, MessageFlowGetsOptions, MessageFlowGetOptions, MessageFlowEditOptions, DEFAULT_MESSAGE_PAGE_SIZE, MessageFlowCreateOptions, MessageComposeOptionsFlow, MessageSearchOptions, PhoneExistsOptions, MessageForwardOptions, ContactUpdatedOptions, ContactGetsOptions } from './Internal/Runtypes'
import { Presence, ChatModification, isGroupID, whatsappID, delay, WAMessageKey, BaileysError, newMessagesDB } from '@adiwajshing/baileys'
import { generateUUID, downloadedFile, fileContent } from './Internal/Utils'
import OpenAPI from './openapi.json'
import { xman_SERVICE_ID, WAAccountInfo, WACompleteChat, WACompleteMessage } from './Internal/Constants'
import P from 'pino'

const AppSlowDown = (options: Object) => SlowDown ({ ...options, keyGenerator: req => req.user.teamId })

export const runApp = async (storeFactory?: StoreFactory) => {
    // Setup store
    storeFactory = storeFactory || new StoreFactory ()
    await storeFactory.init ()
    // Setup App
    const certPath = process.env.CERTS_PATH
    const logger = P().child({  })
    storeFactory.prepareCloudWatchLogger('app', logger)

    process.on('unhandledRejection', (error: any) => (
        logger.info({ error: error?.message, trace: error?.stack?.toString() },`encountered unhandled rejection: ${error}`)
    ))

    let secOptions = null
    try {
        secOptions = {
            cert: await fs.readFile (certPath + 'cert.pem'),
            key: await fs.readFile (certPath + 'key.pem'),
        }
    } catch {
        console.log ('failed to load SSL certifcates')
    }

    const app = App ({
        port: +process.env.PORT || 3001,
        secPort: +process.env.PORT_SEC,
        isBehindProxy: process.env.PRODUCTION === 'true', // behind a proxy in production
        ssePath: '/live',
        // log all errors on sentry for easier debugging
        logAllErrorsOnSentry: false,
        secOptions: secOptions,
        openAPIDocs: OpenAPI,
        authenticator: token => storeFactory.auth.authenticate(token),
        onLiveConnection: teamId => {
            app.getClient(teamId)
            .then(client => app.broadcast (teamId, 'state-sync', client.currentState()))
            .catch(error => (
                logger.error(`error in establishing client for ${teamId}: ${error}`)
            ))
        },
        makeClient: async (teamId, remove: () => void, account?: WAAccountInfo) => {
            try {
                const client = new WAConnection ()
                client.onAnyEvent = (ev, data) => app.broadcast (teamId, ev, data)
    
                const store = storeFactory.newStore(teamId)
                await store.init (teamId)
                await client.init (store, account)
                
                return client
            } catch (error) {
                storeFactory.cloudWatch.log(teamId, { type: 'init-error', message: error.message, trace: error?.stack?.toString() })
                throw error
            }
        }
    })
    const _close = app.close
    app.close = async () => {
        await _close.call (app)
        await delay (2000)
        await storeFactory.close()
    }
    // Load in all the clients who have credentials stored
    // this enables us to schedule their broadcasts & pending messages on boot
    const activeClients = await storeFactory.activeTeams ()
    
    logger.info (`loading ${activeClients.length} active clients`)
    activeClients.forEach(account => (
        app.getClient(account.id, account)
        .catch(error => logger.error(`error in making client for ${account.id}: ${error}`))
    ))

    // connections -------------

    app
    .routing ({ /** fetch current state */
        path: '/',
        method: 'get',
        respond: async (_, client) => client.currentState()
    })
    .routing ({ /** open the connection to WA */
        path: '/open',
        method: 'get',
        respond: (_, client) => client.connect ().then (() => client.currentState())
    })
    .routing ({ /** close the WA connection */
        path: '/close',
        method: 'get',
        middlewares: [  
            AppSlowDown({ windowMs: 60*1000, delayAfter: 5, delayMs: 3000 })
        ],
        respond: async (_, client) => client.close ()
    })
    .routing ({ /** logout from WA */
        path: '/logout',
        method: 'get',
        middlewares: [  
            AppSlowDown({ windowMs: 60*1000, delayAfter: 5, delayMs: 3000 })
        ],
        respond: async (_, client) => client.logout ()
    })
    .routing ({
        path: '/contacts',
        method: 'get',
        middlewares: [
            CacheControl (5*60)
        ],
        type: ContactGetsOptions,
        respond: async ({ onlyUpdated }, client) => client.contactsCleaned (onlyUpdated === 'true')
    })
    
    app
    .routing ({
        path: '/user/exists/:phone',
        method: 'get',
        middlewares: [
            CacheControl (30*60)
        ],
        type: PhoneExistsOptions,
        respond: ({phone}, client) => client.assertOnWhatsApp(phone.toString())
    })
    .routing ({
        path: '/user/status/:jid',
        method: 'get',
        middlewares: [
            CacheControl (15*60)
        ],
        type: ChatPresenceSubscription,
        respond: ({jid}, client) => client.getStatus (jid)
    })
    .routing ({
        path: '/user/status',
        method: 'patch',
        type: UserStatusUpdateRequest,
        middlewares: [  
            AppSlowDown({ windowMs: 10*1000, delayAfter: 2, delayMs: 2000 }) // 10s, after 2 reqs, 2s delay
        ],
        respond: ({status}, client) => client.setStatus (status)
    })
    .routing ({
        path: '/user/subscribe/:jid',
        method: 'post',
        type: ChatPresenceSubscription,
        respond: ({jid, subscribe}, client) => client.subscribeToPresenceUpdates (jid, subscribe !== 'false')
    })
    .routing ({
        path: '/user/picture/:jid',
        method: 'get',
        type: MessageGetsOptions,
        middlewares: [
            CacheControl (15*60)
        ],
        respond: async ({jid}, client) => ({ redirect: await client.cachedProfilePicture(jid) })
    })
    .routing ({
        path: '/user/picture/:jid',
        method: 'patch',
        type: ChatPictureUpdateOptions,
        middlewares: [  
            AppSlowDown({ windowMs: 10*1000, delayAfter: 1, delayMs: 2500 })
        ],
        respond: async ({jid, picture}, client) => {
            if (jid !== client.user.jid && !isGroupID(jid)) throw new BaileysError (`invalid jid ${jid}`, { status: 400 })
            
            const response = await client.updateProfilePicture (
                jid, 
                await downloadedFile (picture.url)
            )
            return { imgUrl: response.eurl }
        }
    })

    app
    .routing ({
        path: '/chats',
        method: 'get',
        type: ChatGetsOptions,
        respond: async ({count, before, searchString, archived, unread, group, tags, assignedToMe}, client, user) => {
            tags = typeof tags === 'string' ? [ tags ] : tags
            
            if (client.store.serviceId !== xman_SERVICE_ID && (!!tags || !!assignedToMe)) {
                throw new HTTPError('Disallowed parameters', 403)
            }
            if (tags || assignedToMe) {
                await client.acquireMissingProfiles()
            }
            const {chats: unpreppedChats, cursor} = await client.loadChats (
                +(count || DEFAULT_CHAT_PAGE_SIZE), 
                before, 
                {
                    searchString, 
                    loadProfilePicture: false,
                    custom: chat => (
                        (typeof archived === 'undefined' || (archived === 'true' ? chat.archive === 'true' : !chat.archive)) &&
                        (typeof unread === 'undefined' || (unread === 'true' ? chat.count !== 0 : chat.count === 0)) &&
                        (typeof group === 'undefined' || (isGroupID(chat.jid).toString() === group)) && 
                        (typeof tags === 'undefined' || !!(client.contacts[chat.jid]).profile?.tags.find(({ name }) => tags.includes(name))) &&
                        (typeof assignedToMe === 'undefined' || (client.contacts[chat.jid]).profile?.assignee === user.id)
                    )
                }
            )
            const chats = await client.prepareChatsForSending(unpreppedChats)
            return { chats, cursor, totalChats: client.chats.length }
        }
    })
    .routing ({
        path: '/chats/:jid', 
        method: 'get', 
        type: MessageGetsOptions, 
        respond: async ({jid}, client) => {
            const [chat] = await client.prepareChatsForSending([ client.assertChatGet (jid) ])
            return chat
        }
    })
    .routing ({
        path: '/chats/:jid',
        method: 'patch',
        type: ChatModificationOptions,
        middlewares: [  
            AppSlowDown({ windowMs: 10*1000, delayAfter: 2, delayMs: 1000 })
        ],
        respond: async (options, client) => {
            const duration = options.modification === 'mute' ? +(options.durationMs || 8*60*60*1000) : null
            await client.modifyChat (options.jid, options.modification as any, duration)
            return client.chats.get (whatsappID(options.jid))
        }
    })
    .routing ({
        path: '/chats/:jid',
        method: 'delete',
        middlewares: [  
            AppSlowDown({ windowMs: 10*1000, delayAfter: 2, delayMs: 1000 })
        ],
        type: MessageGetsOptions,
        respond: (options, client) => client.deleteChat (options.jid)
    })
    .routing ({
        path: '/chats/:jid/read',
        method: 'post',
        type: ChatReadOptions,
        respond: ({jid, read}, client) => client.chatRead (jid, read === 'true' ? 'read' : 'unread')
    })
    .routing ({
        path: '/chats/:jid/typing',
        method: 'post',
        type: ChatTypingOptions,
        middlewares: [
            AppSlowDown({ windowMs: 10*1000, delayAfter: 2, delayMs: 2000 })
        ],
        respond: async ({jid, typing}, client) => {
            await client.updatePresence(jid, Presence.available)
            if (typing !== 'false') {
                await client.updatePresence(jid, Presence.composing)
            } else {
                await client.updatePresence(jid, Presence.paused)
            }
        }
    })
    .routing ({
        path: '/chats/:jid/clear-message-cache',
        method: 'post',
        type: MessageGetsOptions,
        respond: ({jid}, client) => (
            client.loadMessages(jid, 1)
            .then(() => client.chats.get(jid))
            .then(chat => { if (chat) chat.messages = newMessagesDB() })
        )
    })

    // ------------ message flows
    const FLOW_LIMITER = [  
        AppSlowDown({ windowMs: 30*1000, delayAfter: 5, delayMs: 2000 })
    ]
    app
    .routing ({
        path: '/message-flows',
        method: 'get',
        type: MessageFlowGetsOptions,
        respond: ({ count, cursor, search }, client) => (
            client.store.messageFlowsLoad (+(count || DEFAULT_MESSAGE_PAGE_SIZE), cursor, search)
        )
    })
    .routing ({
        path: '/message-flows',
        method: 'post',
        type: MessageFlowCreateOptions,
        middlewares: FLOW_LIMITER,
        respond: async (options, client) => {
            await client.uploadToS3IfRequired ( fileContent(options) )
            const flow = await client.store.messageFlowSet (generateUUID (32), options)
            return flow
        }
    })
    .routing ({
        path: '/message-flows/:id',
        method: 'patch',
        type: MessageFlowEditOptions,
        middlewares: FLOW_LIMITER,
        respond: async (options, client) => client.editMessageFlow (options)
    })
    .routing ({
        path: '/message-flows/:flow',
        method: 'delete',
        type: MessageFlowGetOptions,
        middlewares: FLOW_LIMITER,
        respond: ({flow}, client) => client.deleteMessageFlow (flow)
    })
    .routing ({
        path: '/message-flows/:flow',
        method: 'get',
        type: MessageFlowGetOptions,
        respond: ({flow}, client) => client.store.messageFlowGet (flow)
    })
    
    // ------------ messages
    const MESSAGE_LIMITER = [  
        AppSlowDown({ windowMs: 10*1000, delayAfter: 10, delayMs: 1000 })
    ]
    app
    .routing ({
        path: '/messages/search/:jid?',
        method: 'get',
        type: MessageSearchOptions,
        respond: (options, client) => (
            client.searchMessages (options.searchString, options.jid, +(options.count || 30), +(options.page || 1))
        )
    })
    .routing ({
        path: '/messages/:jid',
        method: 'get',
        type: MessageGetsOptions,
        respond: (options, client) => (
            client.loadMessagesAllKinds(
                options.jid, 
                +(options.count || DEFAULT_CHAT_PAGE_SIZE.toString()), 
                options.before
            )
        )
    })
    .routing ({
        path: '/messages/:jid',
        method: 'post',
        type: MessageComposeOptions,
        middlewares: MESSAGE_LIMITER,
        respond: async (options, client) => {
            const message = await client.prepareMessageFromSendOptions (options)
            await client.relayWAMessage (message)
            return message
        }
    })
    .routing ({
        path: '/messages/:jid/:flow',
        method: 'post',
        type: MessageComposeOptionsFlow,
        middlewares: MESSAGE_LIMITER,
        respond: async (options, client) => {
            const message = await client.prepareMessageFromSendOptionsFlow (options)
            await client.relayWAMessage (message)
            return message
        }
    })
    .routing ({
        path: '/messages/:jid/all-pending',
        method: 'delete',
        type: MessageGetsOptions,
        middlewares: MESSAGE_LIMITER,
        respond: ({jid}, client) => (
            client.deleteAllScheduledMessage (jid)
        )
    })
    .routing ({
        path: '/messages/:jid/:messageID',
        method: 'delete',
        type: MessageDeleteOptions,
        middlewares: MESSAGE_LIMITER,
        respond: async ({jid, messageID, forMe}, client) => {
            const key: WAMessageKey = {
                id: messageID,
                fromMe: true,
                remoteJid: jid,
            }
            if (forMe === 'true') {
                await client.clearMessage (key)
                return key
            }
            const message = await client.deleteMessage (jid, key)
            return message.key
        }
    })
    .routing ({
        path: '/messages/:jid/:messageID',
        method: 'patch',
        type: MessageReschedulingOptions,
        middlewares: MESSAGE_LIMITER,
        respond:  ({jid, messageID, scheduleAt}, client) => (
            client.rescheduleMessage (jid, messageID, +scheduleAt)
        )
    })
    .routing ({
        path: '/messages/:jid/:messageID/forward',
        method: 'post',
        type: MessageForwardOptions,
        middlewares: MESSAGE_LIMITER,
        respond: async ({ jid, messageID, jids }, client) => {
            // normalize jids
            jids = Array.isArray(jids) ? jids : [ jids ]
            jids = jids.slice(0, 5) // max people that can be forwarded to in a single request
            // filter out the right jids
            const wa = await Promise.all(jids.map(jid => client.chats.get(jid) ? { jid } : client.isOnWhatsApp(jid)))
            jids = wa.map(v => v?.jid).filter(Boolean)
            // prepare forwarded content
            const message = await client.loadMessage(jid, messageID)
            const fContent = client.generateForwardMessageContent(message)
            // actually send the messages
            const results = await Promise.allSettled(
                jids.map (jid => {
                    const m: WACompleteMessage = client.prepareMessageFromContent(jid, fContent, {})
                    m.scheduled = true
                    return client.relayWAMessage(m)
                })
            )
            // get errors
            const errors = results.reduce((value, item, idx) => item.status === 'rejected' ? ({ ...value, [jids[idx]]: item.reason }) : value, {})
            return { errors: Object.keys(errors).length > 0 && errors }
        }
    })
    .routing ({
        path: '/messages/:jid/:messageID/media',
        method: 'get',
        type: MessageGetOptions,
        middlewares: [
            CacheControl (2*60*60)
        ],
        respond: async ({jid, messageID}, client) => ({ url: await client.mediaMessageUrl (jid, messageID) })
    })

    // ------------ groups
    const GROUP_LIMITER = [  
        AppSlowDown({ windowMs: 10*1000, delayAfter: 5, delayMs: 1000 })
    ]
    app
    .routing ({
        path: '/groups',
        method: 'post',
        type: GroupCreateOptions,
        middlewares: GROUP_LIMITER,
        respond: ({subject, participants}, client) => (
            client.groupCreate (subject, participants)
            .then (({gid}) => client.groupMetadata(gid))
        )
    })
    .routing ({
        path: '/groups/:jid',
        method: 'get',
        type: GroupRetreivalOptions,
        middlewares: GROUP_LIMITER,
        respond: ({jid}, client) => client.groupMetadata (jid)
    })
    .routing ({
        path: '/groups/:jid',
        method: 'delete',
        type: GroupRetreivalOptions,
        middlewares: GROUP_LIMITER,
        respond: ({jid}, client) => client.groupLeave (jid)
    })
    .routing ({
        path: '/groups/:jid/invite-code',
        method: 'get',
        type: GroupRetreivalOptions,
        respond: async ({jid}, client) => ({ code: await client.groupInviteCode (jid) })
    })
    .routing ({
        path: '/groups/:jid/add',
        method: 'put',
        type: GroupModificationOptions,
        middlewares: GROUP_LIMITER,
        respond: ({jid, participants}, client) => client.groupAdd (jid, participants)
    })
    .routing ({
        path: '/groups/:jid/remove',
        method: 'delete',
        type: GroupModificationOptions,
        middlewares: GROUP_LIMITER,
        respond: ({jid, participants}, client) => client.groupRemove (jid, participants)
    })
    .routing ({
        path: '/groups/:jid/promote',
        method: 'patch',
        type: GroupModificationOptions,
        middlewares: GROUP_LIMITER,
        respond: ({jid, participants}, client) => client.groupMakeAdmin (jid, participants)
    })
    .routing ({
        path: '/groups/:jid/demote',
        method: 'patch',
        type: GroupModificationOptions,
        middlewares: GROUP_LIMITER,
        respond: ({jid, participants}, client) => client.groupDemoteAdmin (jid, participants)
    })
    
    // ------------ notes

    app
    .routing ({
        path: '/notes/:jid',
        method: 'post',
        type: NoteComposeOptions,
        middlewares: MESSAGE_LIMITER,
        respond: ({jid, text, tag}, client, user) => (
            client.noteNew (jid, {extendedTextMessage: { text }}, user.id, tag)
        )
    })
    .routing ({
        path: '/notes/:jid/:noteId',
        method: 'patch',
        type: NoteEditOptions,
        middlewares: MESSAGE_LIMITER,
        respond: (options, client, user) => (
            client.noteEdit (options.jid, options.noteId, { text: options.text }, user.id)
        )
    })
    .routing ({
        path: '/notes/:jid/:noteId',
        method: 'delete',
        type: NoteDeleteOptions,
        middlewares: MESSAGE_LIMITER,
        respond: (options, client, user) => (
            client.noteEdit (options.jid, options.noteId, { delete: true }, user.id)
        )
    })

    // ----- internal

    app
    .routing ({
        path: '/_internal/contacts-hook',
        method: 'post',
        type: ContactUpdatedOptions,
        respond: (options, client, user) => (
            client.didReceiveContactsUpdateHook(options, user.id)
        )
    })

    return app
}
