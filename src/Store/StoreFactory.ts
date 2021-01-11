import { S3 } from 'aws-sdk'
import MySQL from 'mysql'
import { s3BucketExists, s3FileExists } from '../Internal/Utils'
import { DefaultStore } from './DefaultStore'
import { AuthenticationController } from '../Internal/Auth'
import { xman_SERVICE_ID, WAAccountInfo } from '../Internal/Constants'
import { ProxyFactory } from '../Internal/ProxyFactory'
import { AudienceController } from '../Internal/Audience'
import { Logger } from 'pino'
import Lawgs from 'lawgs'
import { Mutex } from '@adiwajshing/baileys'

type SQLQuery = (q: string, callback?: (row: {[k: string]: any}) => void, logErrorQuery?: boolean) => Promise<void>
/** Template for storing messages in SQL */
const MessageTableTemplate = table => `CREATE TABLE ${table} (user_id CHAR(128) NOT NULL, chat_id CHAR(64) NOT NULL, message_id CHAR(64) NOT NULL, timestamp TIMESTAMP, message BLOB)`
/** Migrations to do */
const MIGRATIONS = [
    'CREATE TABLE Credentials (id CHAR(128) PRIMARY KEY NOT NULL, cred TEXT NOT NULL, last_connect TIMESTAMP, auto_connect BOOLEAN DEFAULT 1, last_known_user TEXT DEFAULT NULL)',
    'CREATE TABLE MessageFlows (id CHAR(128) PRIMARY KEY NOT NULL, name CHAR(128) NOT NULL, user_id CHAR(128) NOT NULL, flow BLOB NOT NULL, last_updated TIMESTAMP NOT NULL)',
    MessageTableTemplate ('PendingMessages'),
    'CREATE INDEX PendingMessages_idx ON PendingMessages(user_id, message_id)',
    MessageTableTemplate ('notes'),
    'CREATE INDEX notes_idx ON notes (user_id, chat_id, timestamp)',
    'CREATE INDEX notes_idx2 ON notes (user_id, chat_id)',
    'CREATE UNIQUE INDEX notes_m_idx ON notes (user_id, message_id)',
    'CREATE TABLE Webhooks (service_id CHAR(128) NOT NULL, event CHAR(64), url CHAR(255) NOT NULL, PRIMARY KEY (service_id, event, url))',
    `INSERT INTO Webhooks VALUES
        ("xman", "chats-received", "https://api-audience.xman.tech/wa-hook"),
        ("xman", "open", "https://api-audience.xman.tech/wa-hook"),
        ("xman", "chat-update", "https://api-audience.xman.tech/wa-hook"),
        ("xman", "open", "https://api-auth.xman.tech/wa-hook"),
        ("xman", "close", "https://api-auth.xman.tech/wa-hook"),
        ("xman", "message-new", "https://api-nlp.xman.tech/wa-hook"),
        ("xman", "message-status-update", "https://api-campaigns.xman.tech/wa-hook")
        ON DUPLICATE KEY UPDATE service_id=service_id
    `
]

export class StoreFactory {

    readonly s3Region = 'ap-east-1'

    query: SQLQuery
    auth = new AuthenticationController()
    audience = new AudienceController()
    proxy = new ProxyFactory ()

    cloudWatch: any

    webhooks: { [_: string]: { [_: string]: Set<string> } } = {}

    protected s3: S3
    protected bucket: string
    protected mysql: MySQL.Pool 
    protected publicFolder?: string
    protected migrations: string[]
    

    constructor () {
        const id = process.env.AWS_ID
        const secret = process.env.AWS_SECRET
        const bucket = process.env.AWS_BUCKET

        if (!id || !secret || !bucket) throw new Error ('AWS credentials missing')
        
        this.s3 = new S3 ({ accessKeyId: id, secretAccessKey: secret, region: this.s3Region })
        this.bucket = bucket

        const sqlHost = process.env.SQL_HOST
        const sqlPassword = process.env.SQL_PASS
        const sqlUsername = process.env.SQL_USER
        const sqlDB = process.env.SQL_DB

        if (!sqlHost || !sqlUsername || !sqlDB) throw new Error ('SQL credentials missing')

        this.mysql = MySQL.createPool ({
            connectTimeout: 5 * 60 * 1000, // 5 minutes
            acquireTimeout: 5 * 60 * 1000,
            timeout: 5 * 60 * 1000,
            connectionLimit: 5,
            host: sqlHost,
            user: sqlUsername,
            password: sqlPassword,
            database: sqlDB
        })
        this.query = (q, callback, logQuery) => (
            new Promise ((resolve, reject) => {
                this.mysql.query (q, (error, results) => {
                    if (error) {
                        logQuery !== false && console.error(`Error on query '${q}':`, error)
                        reject (error)
                    } else {
                        if (Array.isArray(results)) results.forEach (result => callback(result))
                        resolve ()
                    } 
                })
            })
        )

        this.publicFolder = process.env.PUBLIC_FILES_PATH
        this.migrations = MIGRATIONS
        this.audience.auth = this.auth

        Lawgs.config({
            aws: {
                accessKeyId: id,
                secretAccessKey: secret,
                region: this.s3Region,
            }
        })
        this.cloudWatch = Lawgs.getOrCreate(process.env.AWS_LOG_GROUP)
    }
    async init () {
        // setup or create the AWS bucket
        const exists = await s3BucketExists (this.s3, this.bucket)
        if (!exists) {
            this.log (`bucket '${this.bucket}' does not exist, creating...`)
            
            const response = await this.s3.createBucket (
                {
                    Bucket: this.bucket,
                    ACL: 'public-read'
                }
            ).promise ()
            
            this.log (`created bucket: '${this.bucket}, location: ${response.Location}'`)
        }
        this.log ('connected to AWS')
        
        // run SQL migrations
        for (let migration of this.migrations) {
            await this.runMigration (migration)
        }
        this.log ('ran SQL migrations')

        // obtain the public key for JWT verification
        await this.auth.init ()
        await this.proxy.init ()
        
        await this.loadWebHooksIfRequired (xman_SERVICE_ID) // load xman webhooks

        return this
    }
    newStore (teamId: string) {
        const store = new DefaultStore ()
        store.teamId = teamId
        store.options = this
        return store
    }
    async activeTeams () {
        // teams that are logged in & have autoConnect enabled
        return this.accountsQuery ('cred IS NOT NULL AND LENGTH(cred) > 0 AND auto_connect=\'1\'')
    }
    async accountsQuery (whereClause: string) {
        const accounts: WAAccountInfo[] = []
        
        await this.query (`SELECT id, cred, UNIX_TIMESTAMP(last_connect) as last_connect, auto_connect, last_known_user from Credentials WHERE id IS NOT NULL AND ${whereClause}`, row => {
            accounts.push (
                {
                    id: row.id,
                    creds: row.cred && JSON.parse (row.cred),
                    lastConnect: row.last_connect && new Date(+row.last_connect*1000),
                    autoReconnect: row.auto_connect?.toString() !== '0',
                    lastKnownUser: row.last_known_user && JSON.parse(row.last_known_user)
                }
            )
        })
        return accounts
    }
    async s3FileExists (file: string) {
        return s3FileExists (this.s3, this.bucket, file)
    }
    @Mutex(key => key)
    async s3PutObject (key: string, buffer: Buffer) {
        const params: S3.PutObjectRequest = {
            Bucket: this.bucket, 
            Key: key, 
            Body: buffer, 
            ACL: 'public-read',
            CacheControl: 'max-age=604800'
        }
        await this.s3.upload (params).promise ()
    }
    async close () {
        this.mysql.end ()
    }
    async loadWebHooksIfRequired (service: string) {
        if (service in this.webhooks) return
        await this.query (`SELECT event, url FROM Webhooks WHERE service_id="${service}"`, row => {
            row.event = row.event || ''
            if (typeof this.webhooks[service] === 'undefined') this.webhooks[service] = {}
            if (typeof this.webhooks[service][row.event] === 'undefined') this.webhooks[service][row.event] = new Set ()

            this.webhooks[service][row.event].add (row.url)
        })
    }
    prepareCloudWatchLogger (stream: string, logger: Logger) {
        const methods = ['trace', 'debug', 'info', 'error']
        methods.forEach(methodName => {
            const method = logger[methodName]
            logger[methodName] = (...args: any[]) => {
                const obj = typeof args[0] === 'object' ? { ...args[0] } : { message: args[0] }
                if(args[1]) obj.message = args[1]
                obj.level = methodName
                this.cloudWatch.log(stream, obj)

                method.apply(logger, args)
            }
        })
    }
    protected async runMigration (migration: string) {
        try {
            await this.query (migration, undefined, false)
        } catch (error) {
            // if it is an EXISTS error ignore
            if (!error.message.includes('EXISTS') && !error.message.includes('DUP')) throw error
        }
    }
    protected log (txt: any) {
        console.log (txt)
    }
}
