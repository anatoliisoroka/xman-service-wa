import got from 'got'
import { URL } from 'url'
import { AuthenticationController } from './Auth'
import { xmanContact } from './Constants'

const AUD_SERVICE_URL = process.env.AUDIENCE_SERVICE_URL

export class AudienceController {

    auth: AuthenticationController

    async fetchContacts (teamId: string, query: { contacts?: string[] }) {
        const token = await this.auth.getToken (teamId)
        const url = new URL('/contacts?page-size=100000' + (query.contacts?.length ? `&large-contacts=true` : ''), AUD_SERVICE_URL)
        const res = await got.post (
            url, 
            { 
                headers: { 
                    'authorization': `Bearer ${token}`, 
                    'content-type': 'application/json' 
                },
                body: JSON.stringify(query.contacts) 
            }
        )
        const { contacts }: { contacts: xmanContact[] } = JSON.parse (res.body)
        return contacts
    }
}