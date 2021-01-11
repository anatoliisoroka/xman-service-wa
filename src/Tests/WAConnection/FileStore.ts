import { AuthenticationCredentialsBase64, unixTimestampSeconds, whatsappID } from "@adiwajshing/baileys"
import fs from 'fs/promises'
import { obfuscatedID } from "../Internal/Utils"
import { WACompleteMessage, WACampaignGetsOptions, WA_CAMPAIGN_MESSAGE_STATES, WACampaignData, WACampaignRecipient, WACampaignMessageState, WACampaignEditOptions, WACampaignState, WACampaignMetadata, WACampaignComposeOptions } from "../Internal/Constants"
import { Store } from "../Internal/Store"

const MAIN_FOLDER = './data/'

/** Testing storage mechanism */
export class FileStore implements Store {
    teamId: string = ''
    waId: string = ''

    credentialsFolder = `${MAIN_FOLDER}credentials/`
    mediaFolder = `${MAIN_FOLDER}media/`
    pendingFolder = `${MAIN_FOLDER}pending/`
    notesFolder = `${MAIN_FOLDER}notes/`
    campaignsFolder = `${MAIN_FOLDER}campaigns/`

    constructor (teamId: string) {
        this.teamId = teamId
    }

    async init () {
        const folders = [this.credentialsFolder, this.mediaFolder, this.pendingFolder, this.notesFolder, this.campaignsFolder]
        for (let folder of folders) {
            try {
                await fs.access(folder)
            } catch {
                await fs.mkdir (folder, {recursive: true})
            }
        }
    } 
    async getCredentials () {
        const path = this.credentialsFolder + this.teamId + '-creds.json'
        try {
            await fs.access(path)
            const file = await fs.readFile (path, {encoding: 'utf-8'})
            return JSON.parse (file) as AuthenticationCredentialsBase64
        } catch {
            return null
        }
    }
    async setCredentials (creds?: AuthenticationCredentialsBase64) {
        const path = this.credentialsFolder + this.teamId + '-creds.json'
        if (creds) await fs.writeFile (path, JSON.stringify(creds))
        else await fs.unlink (path)
    }
    async getLastConnectionDate () {
        const path = this.credentialsFolder + this.teamId + '-last-conn.json'
        try {
            await fs.access(path)
            const file = await fs.readFile (path, {encoding: 'utf-8'})
            return new Date (+file)
        } catch {
            return null
        }
    }
    async setLastConnectionDate (date?: Date) {
        const path = this.credentialsFolder + this.teamId + '-last-conn.json'
        if (date) await fs.writeFile (path, date.getTime().toString())
        else await fs.unlink (path)
    }

    async mediaMessageExists (messageID: string, jid: string) {
        const filename = this.mediaFolder + obfuscatedID (messageID, jid)
        try {
            await fs.access (filename)
            return true
        } catch {
            return false
        }
    }
    async setMediaMessage (messageID: string, jid: string, content: Buffer) {
        const filename = this.mediaFolder + obfuscatedID (messageID, jid)
        await fs.writeFile (filename, content)
    }

    urlForMediaMessage (messageID: string, jid: string) {
        return 'file:///media/' + obfuscatedID (messageID, jid)
    }

    async pendingMessagesLoad () {
        const file = `${this.pendingFolder}${this.teamId}-pending.json`
        try {
            await fs.access (file)
        } catch {
            return []
        }
        const content = await fs.readFile (file, { encoding: 'utf-8' })
        return JSON.parse (content) as WACompleteMessage[]
    }
    async pendingMessageSet (messageID: string, message?: WACompleteMessage) {
        const file = `${this.pendingFolder}${this.teamId}-pending.json`
        
        const dict = await this.pendingMessagesLoad ()
        const index = dict.findIndex (m => m.key.id === messageID)

        if (message) {
            if (index >= 0) dict[index] = message
            else dict.push(message)
        } else if (index >= 0) dict.splice (index, 1)

        await fs.writeFile (file, JSON.stringify(dict))
    }
    async notesLoad (jid: string, before: number | null, till: number | null) {
        const notes = await this.notesLoadAll (jid)
        return notes.filter (note => (note.messageTimestamp <= before || !before) && (note.messageTimestamp > till || !till))
    }
    async notesGet (jid: string, noteID: string) {
        const notes = await this.notesLoadAll (jid)
        return notes.find(n => n.key.id === noteID)
    }
    async notesSet (jid: string, noteID: string, note: WACompleteMessage | null) {
        const notes = await this.notesLoadAll (jid)
        
        const idx = notes.findIndex (n => n.key.id === noteID)
        if (!note) notes.splice (idx, 1)
        else if (idx < 0) notes.push (note)
        else notes[idx] = note 

        await fs.writeFile (
                `${this.notesFolder}${this.teamId}-${jid}-notes.json`,
                JSON.stringify (notes)
            )
    }
    private async notesLoadAll (jid: string) {
        const file = `${this.notesFolder}${this.teamId}-${jid}-notes.json`
        try {
            await fs.access (file)
        } catch {
            return []
        }
        const content = await fs.readFile (file, { encoding: 'utf-8' })
        return JSON.parse (content) as WACompleteMessage[]
    }

    async campaignGets (options: WACampaignGetsOptions) {
        const campaigns = await this.campaignsGetAll ()
        return campaigns.filter (c => (
            (!options.before || c.updatedAt < options.before) &&
            (!options.campaignId || c.id === options.campaignId) && 
            (!options.onlyPending || (c.state === WACampaignState.pending || c.state === WACampaignState.revoking || c.state === WACampaignState.progess) )
        ))
        .sort ((a, b) => b.createdAt-a.createdAt)
        .slice (0, options.limit)
        .map (this.makeCampaignMetaData)
    }
    async campaignCreate (campaignId: string, campaign: WACampaignComposeOptions) {
        const created: WACampaignData = {
            id: campaignId,
            state: WACampaignState.pending,
            updatedAt: unixTimestampSeconds(),
            createdAt: unixTimestampSeconds(),
            name: campaign.name,
            sendInterval: campaign.sendInterval,
            message: campaign.message,
            scheduledAt: campaign.scheduledAt,
            pending: campaign.recipientJids.map (({jid, tag}) => ({recipient: jid, tag, timestamp: unixTimestampSeconds()})),
            revoked: [],
            delivered: [],
            sent: [],
            failed: [],
        }
        const all = await this.campaignsGetAll ()
        all.splice (0, 0, created)
        await this.campaignsSetAll (all)

        return this.makeCampaignMetaData (created)
    }
    async campaignEdit (options: WACampaignEditOptions) {
        const campaigns = await this.campaignsGetAll ()
        const campaign = campaigns.find (c => c.id === options.id)

        if (options.name) campaign.name = options.name
        if (options.addRecipients && options.addRecipients.length > 0) {
            campaign.pending.push (...options.addRecipients.map(({jid, tag}) => ({recipient: jid, tag, timestamp: unixTimestampSeconds()})))
        }
        if (options.removeRecipients && options.removeRecipients.length > 0) {
            campaign.pending = campaign.pending.filter (c => !options.removeRecipients.includes(c.recipient))
        }
        if (options.removeTags && options.removeTags.length > 0) {
            campaign.pending = campaign.pending.filter (c => !options.removeTags.includes(c.tag))
        }
        if (options.message) campaign.message = options.message
        if (options.scheduledAt) campaign.scheduledAt = options.scheduledAt
        if (options.state) campaign.state = options.state

        await this.campaignsSetAll (campaigns)
    }
    async campaignGetFull (campaignId: string) {
        const campaigns = await this.campaignsGetAll ()
        return campaigns.find (c => c.id === campaignId)
    }
    async campaignGetRecipients (campaignId: string, ...states: WACampaignMessageState[]) {
        const campaign = await this.campaignGetFull (campaignId)
        const list: WACampaignRecipient[] = []
        
        states.forEach (state => {
            const sList = campaign[WACampaignMessageState[state]]
            sList && list.push (...sList)
        })
        return list
    }
    async campaignFindMessage (messageID: string) {
        const campaigns = await this.campaignsGetAll ()
        for (var campaign of campaigns) {
            const recps = await this.campaignGetRecipients (campaign.id, WA_CAMPAIGN_MESSAGE_STATES.map(k => WACampaignMessageState[k]) as any)
            const recp = recps.find (r => r.messageID === messageID)
            if (recp) return { campaignId: campaign.id, data: recp }
        }
    }
    async campaignUpdateMessageState (campaignId: string, jid: string, state: WACampaignMessageState, messageID?: string) {
        const campaigns = await this.campaignsGetAll ()
        const c = campaigns.find (c => c.id === campaignId)
        jid = whatsappID (jid)
        let item: WACampaignRecipient
        for (let state of WA_CAMPAIGN_MESSAGE_STATES) {
            const arr = c[state] as WACampaignRecipient[]
            const idx = arr.findIndex (i => i.recipient === jid)
            if (idx >= 0) {
                item = arr[idx]
                arr.splice (idx, 1)
                break
            }
        }
        const arr = c[ WACampaignMessageState[state] ] as WACampaignRecipient[]
        
        if (messageID) item.messageID = messageID
        item.timestamp = unixTimestampSeconds ()
        arr.push (item)

        await this.campaignsSetAll (campaigns)
    }
    
    private makeCampaignMetaData = (data: WACampaignData) => {
        let ndata = data as any
        ndata.counts = {} 
        WA_CAMPAIGN_MESSAGE_STATES.forEach (value => {
            ndata.counts[value] = ndata[value]?.length || 0
            delete ndata[value]
        })
        return ndata as WACampaignMetadata
    }
    private async campaignsGetAll () {
        const file = `${this.campaignsFolder}${this.teamId}.json`
        try {
            await fs.access (file)
        } catch {
            return []
        }
        const content = await fs.readFile (file, { encoding: 'utf-8' })
        return JSON.parse (content) as WACampaignData[]
    }
    private async campaignsSetAll (campaigns: WACampaignData[]) {
        const file = `${this.campaignsFolder}${this.teamId}.json`
        await fs.writeFile (file, JSON.stringify(campaigns, null, '\t'))
    }
}