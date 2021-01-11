import { describeWithConnection, generateJids } from "./Common";
import assert from 'assert'
import { unixTimestampSeconds, WATextMessage, MessageType } from "@adiwajshing/baileys";
import { WACampaignComposeOptions, WACampaignEditOptions, WACampaignState } from "../Internal/Constants";
import { unlinkSync } from "fs";

const TEST_CAMPAIGN_NAME = 'Test Campaign'

describeWithConnection ('WA Campaigns', false, conn => {

    after (() => {
        unlinkSync ('./data/campaigns/adhiraj.json')
    })

    const createCampaign = async () => {
        const jids = generateJids (15)
        const options: WACampaignComposeOptions = {
            name: TEST_CAMPAIGN_NAME,
            recipientJids: jids.map (jid =>({jid})),
            scheduledAt: unixTimestampSeconds() + 60*60, // 1 hour in the future,
            sendInterval: 0.5,
            message: {
                message: 'what a cool campaign',
                type: MessageType.text,
                options: {},
            }
        }
        const campaign = await conn.campaignCompose(options)
        
        const campaigns = await conn.campaignGets (10)
        assert.equal (campaigns[0].name, options.name)
        assert.equal (campaigns[0].id, campaign.id)

        const full = await conn.campaignGetFull (campaign.id)
        assert.deepEqual (full.pending.filter(item => jids.includes(item.recipient)), full.pending) 
    }
    const requireCampaign = async () => {
        const campaigns = await getCampaigns ()
        let campaign = campaigns.find (c => c.name === TEST_CAMPAIGN_NAME)
        if (!campaign) {
            await createCampaign ()
            campaign = (await conn.campaignGets (1))[0]
        }
        return campaign
    }
    const getCampaigns = () => conn.campaignGets (10).then (c => c.campaigns)

    it ('should create a campaign', createCampaign)

    // add and remove recipients associated with a tag
    it ('should edit a campaign', async () => {
        const campaign = await requireCampaign ()
        const edit1: WACampaignEditOptions = {
            id: campaign.id,
            addRecipients: generateJids (5).map (jid => ({jid, tag: 'VIP Segment'}))
        }
        const edit2 = {
            id: campaign.id,
            removeTags: ['VIP Segment'] 
        }
        const full0 = await conn.campaignGetFull (campaign.id)
        
        await conn.campaignEdit (edit1)
        
        const full1 = await conn.campaignGetFull (campaign.id)
        assert.ok (full1.pending.length > full0.pending.length)

        await conn.campaignEdit (edit2)
        
        // full2 should be the same as full0
        const full2 = await conn.campaignGetFull (campaign.id)
        assert.equal (full2.pending.length, full0.pending.length)
        assert.deepEqual (
            full0.pending.filter (i => full2.pending.find(j => i.recipient === j.recipient)), 
            full0.pending
        )
    })

    it ('should execute a campaign', async () => {
        const campaign = await requireCampaign ()
        console.log (`executing campaign: ${JSON.stringify(campaign)}`)
        
        const fullCampaign = await conn.campaignGetFull (campaign.id)

        const receivedStart = new Promise (resolve => {
            conn.on ('campaign-update', ({id, state}) => {
                console.log ('received campaign update for: ' + id)
                if (id === fullCampaign.id && state === WACampaignState.progess) {
                    resolve ()
                } 
            })
        })

        let updatesReceived = 0
        conn.on ('campaign-update', async update => {
            //console.log ('received campaign update: ' + JSON.stringify(update))
            if (update.state) return

            updatesReceived += 1
            if (updatesReceived === Math.floor(campaign.counts.pending/2)) {
                console.log ('restarting campaign')
                await conn.campaignStop (campaign.id)
                await conn.campaignStart (campaign.id)
            }
            
        })
        const receivedFinish = new Promise (resolve => {
            conn.on ('campaign-update', ({id, state}) => {
                if (id === fullCampaign.id && state === WACampaignState.finished) resolve ()
            })
        })

        await conn.campaignStop (campaign.id)
        await conn.campaignStart (campaign.id)

        await receivedStart
        await receivedFinish
        
        const finishedCampaign = await conn.campaignGetFull (campaign.id)
        assert.equal (finishedCampaign.pending.length, 0)
        assert.equal (finishedCampaign.state, WACampaignState.finished)
        
        assert.ok (finishedCampaign.sent.length > 0)
        assert.ok (!finishedCampaign.sent.find(item => !item.messageID))

        let sum = finishedCampaign.sent.length + finishedCampaign.failed.length
        assert.ok (updatesReceived <= sum)
    })
    it ('should revoke a campaign', async () => {
        const campaigns = await getCampaigns ()
        let campaign = campaigns.find (c => c.name === TEST_CAMPAIGN_NAME && c.state !== WACampaignState.pending)
        if (!campaign) throw new Error ('could not find appropriate campaign')

        console.log (`revoking campaign: ${JSON.stringify(campaign)}`)
        const fullCampaign = await conn.campaignGetFull (campaign.id)

        if (campaign.state === WACampaignState.progess) {
            console.log ('stopping campaign before revoke')
            await conn.campaignStop (campaign.id)
        }
        
        conn.on ('campaign-update', update => {
            console.log ('received campaign update: ' + JSON.stringify(update))
        })
        const receivedFinish = new Promise (resolve => {
            conn.on ('campaign-update', ({id, state}) => {
                if (id === fullCampaign.id && state === WACampaignState.revoked) resolve ()
            })
        })
        if (campaign.state !== WACampaignState.revoking) {
            await conn.campaignRevoke (fullCampaign.id)
        }

        await receivedFinish

        const finishedCampaign = await conn.campaignGetFull (campaign.id)
        assert.equal (finishedCampaign.pending.length, 0)
        assert.equal (finishedCampaign.state, WACampaignState.revoked)
        assert.equal (finishedCampaign.revoked.length, fullCampaign.sent.length)

        for (var revokee of finishedCampaign.revoked) {
            await conn.deleteChat (revokee.recipient)
        }
    })
})