import assert from 'assert'
import { WAMessage, delay } from "@adiwajshing/baileys";

import { describeWithServer, request, TEST_JID } from "./Common";
import { Static } from 'runtypes';
import { MessageFlowCreateOptions } from '../Internal/Runtypes';
import { WAMessageFlow } from '../Internal/Constants';
import { fileContent } from '../Internal/Utils';

type MessageFlowCreate = Static<typeof MessageFlowCreateOptions> 
const IMG_FLOW: MessageFlowCreate = {
    name: 'tom-meme',
    text: 'Tom is going to snitch on you',
    image: {
        url: 'https://www.memestemplates.com/wp-content/uploads/2020/05/tom-with-phone.jpg',
        mimetype: 'image/jpeg',
        name: 'tom.jpeg'
    }
}

describeWithServer ('Message Flows', app => {

    const saveMessageFlow = async (flow: MessageFlowCreate) => {
        const {id}: WAMessageFlow = await request ('/message-flows', 'POST', flow)
        const {flows} = await request ('/message-flows?count=100', 'GET')
        const found = flows.find (r => r.id === id)
        assert.ok (found)

        assert.ok (
            await request ('/message-flows/' + id, 'GET')
        )
        
        Object.keys (flow).forEach (key => assert.deepEqual(found[key], flow[key]))
        return id
    }
    it ('should save a text message flow', async () => {
        await saveMessageFlow ({ name: 'some flow', text: 'what a cool flow' })
    })
    it ('should save a file message flow', async () => {
        await saveMessageFlow (IMG_FLOW)
    })
    it ('should edit a message flow', async () => {
        const id = await saveMessageFlow (IMG_FLOW)
        const edit = {
            name: 'new-name',
            text: 'this is now a text message'
        }
        await request (`/message-flows/${id}`, 'PATCH', edit)
        
        const edited: WAMessageFlow = await request (`/message-flows/${id}`, 'GET')
        assert.equal (edited.name, edit.name)
        assert.equal (edited.text, edit.text)
        
        assert.ok (!edited.image) // image should be absent
    })
    it ('should fail to send a message flow', async () => {
        await assert.rejects (
            request ('/message-flows', 'POST', {
                
            })
        )
        await assert.rejects (
            request ('/message-flows', 'POST', {
                name: 'hellow'
            })
        )
        await assert.rejects (
            request ('/message-flows', 'POST', {
                name: 'hellow',
                image: {
                    url: '12123123',
                    mimetype: 'image/jpeg',
                    name: 'tom.jpeg'
                },
                video: {
                    url: '11222222',
                    mimetype: 'video/mp4',
                    name: 'tom.jpeg'
                }
            })
        )
    })
    it ('should paginate message flows correctly', async () => {
        let COUNT = 30
        const obj: {flows: WAMessageFlow[]} = await request (`/message-flows?count=100`, 'GET')
        if (obj.flows.length < COUNT) {
            const len = COUNT-obj.flows.length
            console.log (`creating ${len} new flows`)
            await Promise.all (
                [...Array(len)].map ((m, i) => (
                    saveMessageFlow ({ name: `flow-${i}`, text: 'Helloz' })
                ))
            )
        } else {
            COUNT = obj.flows.length
        }

        let flows: WAMessageFlow[] = []
        let cursor
        do {
            const obj: {flows: WAMessageFlow[], cursor} = await request (`/message-flows?count=5${ cursor ? `&cursor=${cursor}` : '' }`, 'GET')
            // ensure no duplicates
            const totalSet = new Set([ ...flows.map(({ id }) => id), ...obj.flows.map(({ id }) => id) ])
            assert.strictEqual(totalSet.size, obj.flows.length + flows.length)

            flows = [...flows, ...obj.flows]
            cursor = obj.cursor
        } while (cursor)

        assert.ok (flows.length === COUNT, `Got ${flows.length} flows`)
    })
    it ('should send a text message flow', async () => {
        const {flows} = await request ('/message-flows', 'GET')
        const flow = flows.find (f => !!f.text && !f.image)
        
        const message: WAMessage = await request (`/messages/${TEST_JID}/${flow.id}`, 'POST')
        assert.ok (message)

        assert.equal (message.message.extendedTextMessage.text, flow.text)
    })
    it ('should send a randomized text message flow', async () => {
        const {flows} = await request ('/message-flows', 'GET')
        const flow = flows.find (f => !!f.text && !f.image)

        let differences = 0
        await Promise.all (
            [...Array(5)].map (async () => {
                await delay (Math.random() * 10000)
                const message: WAMessage = await request (`/messages/${TEST_JID}/${flow.id}`, 'POST', { randomizeMessage: true })
                assert.ok (message)
                if (message.message.extendedTextMessage.text !== flow.text) {
                    differences += 1
                }
            })
        )        
        assert.ok (differences > 0)
    })
    it ('should send a message flow with parameters', async () => {
        const id = await saveMessageFlow ({ name: 'sample-flow', text: 'hello {name}, this is from {name2}. {name} is a nice name' })

        let message: WAMessage = await request (`/messages/${TEST_JID}/${id}`, 'POST', { parameters: { name: 'ABC', name2: 'XYZ' } })
        
        assert.ok (message)
        assert.equal (message.message.extendedTextMessage.text, 'hello ABC, this is from XYZ. ABC is a nice name')

        message = await request (`/messages/${TEST_JID}/${id}`, 'POST', { parameters: { name: '123', name2: '456' } })
        
        assert.ok (message)
        assert.equal (message.message.extendedTextMessage.text, 'hello 123, this is from 456. 123 is a nice name')
    })
    it ('should send a file message flow', async () => {
        const {flows}: {flows: WAMessageFlow[]} = await request ('/message-flows', 'GET')
        const flow = flows.find (m => !!fileContent(m))?.id || await saveMessageFlow (IMG_FLOW)
       
        for (let i = 0; i < 2;i++) { // send twice
            const message: WAMessage = await request (`/messages/${TEST_JID}/${flow}`, 'POST')
            assert.ok (message)
        }
        
    })
})