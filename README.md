# xman WhatsApp Service

Service Endpoint: `https://api-wa.xman.tech`

## TODO
- Assign conversations to users (TODO)

## Some Info

- All outputs are JSON encoded, however a url-encoded or multipart input is accepted
- Expect a `content-type: application/json`

### Using the API

- The API conforms well to the Open API standards
- An authentication token must be provided via a Bearer authorization header or an `access_token` query parameter. Example:
    - `https://api-wa.xman.tech?access_token=xyz`
    - This access token can be obtained via the auth service from `https://api-audience.xman.tech/oauth/token` (Read the docs [here](https://api-audience.xman.tech/docs)). If you're building a service to interact with the WA service, use your service `refresh token` to generate tokens for any given team via the aforementioned route.
- To listen for live events, setup an event source on: `/live`

## Broadcast Campaigns

### Getting Campaigns

- **Endpoint** POST /campaign/gets
- **Body**: 
    ``` ts
        {
            // cursor to get the next page of campaigns
            before?: number
        }
    ```
- Returns: array of campaign metadata

### Getting the full data for a campaign

This includes who it's been sent to, failed to, revoked etc.

- **Endpoint** POST /campaign/get-full
- **Body**: 
    ``` ts
        {
            // id of the campaign
            id?: string
        }
    ```
- Returns: the campaign data

### Creating a campaign

This includes who it's been sent to, failed to, revoked etc.

- **Endpoint** POST /campaign/compose
- **Body**: 
    ``` ts
        {
            // name of the campaign
            name?: string,
            // unix timestamp in seconds to schedule
            scheduledAt: number,
            // interval between each message sent between [0.5, 10]
            sendInterval: number,
            // the segments which will receive the campaign
            recipientTags: string[],
            // the numbers which will receive this campaign, attach a `@s.whatsapp.net` to the numbers
            recipientJids: string[],
            message: {
                text: string
                messageType: 'extendedTextMessage' | 'videoMessage' | 'imageMessage' | 'stickerMessage',
                file: {
                    buffer: Buffer
                }
            }
        }
    ```
- Returns: generates & schedules the campaign metadata

### Editing a campaign

- **Endpoint** POST /campaign/edit
- **Body**: 
    ``` ts
        {
            // name of the campaign
            name?: string,
            // unix timestamp in seconds to schedule
            scheduledAt?: number,
            // interval between each message sent between [0.5, 10]
            sendInterval?: number,
            // add segments which will receive the broadcast
            addTags?: string[],
            // remove segments
            removeTags?: string[],
            // add numbers which will receive this campaign, attach a `@s.whatsapp.net` to the numbers
            addJids: string[],
            removeJids: string[],
            // change the message being sent
            message: {
                text: string
                messageType: 'extendedTextMessage' | 'videoMessage' | 'imageMessage' | 'stickerMessage',
                file: {
                    buffer: Buffer
                }
            }
        }
    ```
- Returns: edits the campaign & returns the edited properties

### Starting a campaign

- **Endpoint** POST /campaign/start
- **Body**: 
    ``` ts
        {
            id: string?
        }
    ```
- Returns: starts the campaign, returns the campaign ID

### Stopping a campaign

- **Endpoint** POST /campaign/stop
- **Body**: 
    ``` ts
        {
            id: string?
        }
    ```
- Returns: stops the campaign, returns the campaign ID

Do note, you can start the campaign again via `/start` or reschedule by editing the scheduled at property via `/edit`

### Revoking a campaign

Will delete all sent messages off everyone's phones.

- **Endpoint** POST /campaign/revoke
- **Body**: 
    ``` ts
        {
            id: string?
        }
    ```
- Returns: starts revoking the campaign, returns the campaign ID

Do note, you can stop this revoking via `campaign/stop`