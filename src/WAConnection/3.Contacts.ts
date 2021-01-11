import { Mutex, newMessagesDB, WAChat, WAChatUpdate } from '@adiwajshing/baileys'
import { xmanContact, xman_SERVICE_ID, ContactsUpdatedData, WACompleteChat, WACompleteContact } from '../Internal/Constants'
import { WAConnection as Base } from './2.Notes'

export class WAConnection extends Base {

    async didReceiveContactsUpdateHook ({ event, data }: ContactsUpdatedData, author: string) {
        switch (event) {
            case 'contacts-update':
                const updates: WAChatUpdate[] = []
                await Promise.all(data.phoneNumbers.map(async phone => {
                    const jid = phone + '@s.whatsapp.net'
                    const { profile } = (this.contacts[jid] || {}) as WACompleteContact
                    const update = { jid } as any
                    
                    if (profile) {
                        profile.name = data.name || profile.name
                        profile.assignee = data.assignee || profile.assignee
                        if (data.addTags) {
                            data.addTags.forEach(name => profile.tags.push({name}))
                        }
                        if (data.removeTags) {
                            const rTags = new Set(data.removeTags)
                            profile.tags = profile.tags.filter(({ name }) => !rTags.has(name))
                        }
                        update.profile = profile
                    }
                    if (typeof data.assignee !== 'undefined' && data.assignee !== null) {
                        const note = await this.noteNewProtocolMessage(
                            jid, 
                            'ASSIGNEE_CHANGED', 
                            data.assignee ? [ data.assignee ] : [ ], 
                            author
                        )
                        update.messages = newMessagesDB([ note ])
                    }
                    if (Object.keys(update).length > 1) {
                        updates.push(update)
                    }
                }))
                this.logger.info({ length: updates.length }, 'received contacts update, updated ' + updates.length + ' profiles')
                if (updates.length > 0) this.emit('chats-update', updates)

            break
        }
    }
    /**
     * Fetches profiles for missing chats from the audience service
     * @param chats 
     */
    @Mutex()
    async acquireMissingProfiles (chats?: WACompleteChat[]) {
        // only direct xman users should be able to avail this
        if (this.store.serviceId !== xman_SERVICE_ID) {
            return
        }
        
        chats = chats || this.chats.all()
        let filtered = chats.map(({jid}) => (
            !this.contacts[jid]?.profile && jid.endsWith('@s.whatsapp.net') && jid.slice(0, -15)
        )).filter(Boolean)

        if (filtered.length > 0) {
            // small efficiency improvement
            // don't send filtered if we don't have 80% of the contacts
            if (filtered.length > chats.length*0.8) {
                filtered = []
            }
            let profiles: xmanContact[] = []
            try {
                profiles = await this.store.fetchContacts(filtered)
                this.logger.info(`acquired ${profiles.length} contacts`)
            } catch (error) {
                this.logger.warn(`failed to acquire contacts: ${error}`)
            }
            profiles.forEach(profile => {
                const jid = `${profile.phone}@s.whatsapp.net`
                this.contacts[jid] = {
                    ...(this.contacts[jid] || {}),
                    jid,
                    profile
                }
            })
        }
    }
    async prepareChatsForSending (chats: WACompleteChat[]) {
        const prepped = await super.prepareChatsForSending(chats)
        await this.acquireMissingProfiles(chats)
        prepped.forEach(chat => chat.profile = this.contacts[chat.jid]?.profile)
        return prepped
    }
}