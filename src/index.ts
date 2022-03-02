import type { Client, FileType} from './types'
import { config } from '../config'
import { login, getAuthToken } from './functions/authorization'
import { getPlaylists, getItemsByPlaylists } from './functions/spotifyApiUtils'
import { generateReturnFile } from './functions/generateReturnFile'

import type { Express } from 'express'
import express from 'express'
import http from 'http'
import { Server } from 'socket.io'
import cors from 'cors'
import path from 'path'
import fs from 'fs'
import { URLSearchParams } from 'url'
import * as ejs from 'ejs'

const app: Express = express()
const port: string | number = process.env.PORT || 8000
const server = http.createServer(app)
const io = new Server(server)

// This is probably a bad idea if this thing scales. Probably better use npm-cache or Redis, or a database, when that happens
let clients: Client[] = []

// Setup static directory to serve
app.use(express.static(path.join(__dirname, '../public')))

app.use(
    cors({
        origin: config.baseUrl,
    })
)

// Only want to use html with some variables -> using EJS
app.engine('html', ejs.renderFile)

app.get('/', function (req, res) {
    res.sendFile(path.join(__dirname, '../public/views/index.html'))
})

app.get('/login', function (req, res) {
    const client = clients.find((client) => {
        return client.sessionId === req.query.sessionId as string
    })
    if (!client) {
        throw new Error(`Request not coming from an active session.`)
    }
    client.fileType = req.query.fileType as FileType
    res.redirect(login(client))
})

app.get('/spotify-app-callback', async function (req, res) {
    // In order to remove the code from the url
    res.redirect('../')

    const code: string = (req.query.code as string) || null
    const state = req.query.state || null
    const error = req.query.error || null

    const authToken = await getAuthToken(code)

    // This is a bit dodgy as socket.io creating the client will race with getting the auth token
    // Also, ideally, you'd also get the sessionId in the callback and get the client.state from there
    const client = clients.find((client) => {
        return client.state === state
    })
    if (!client) {
        res.redirect(
            '/#' +
                new URLSearchParams({
                    error: 'state_mismatch: no active client found with received state',
                })
        )
    }

    sendLoadingMessageToClient(client.socketId, `Succesfully signed in to your Spotify Account`)

    const playlists = await getPlaylists(authToken, 'https://api.spotify.com/v1/me/playlists', [])

    sendLoadingMessageToClient(
        client.socketId,
        `Retrieved ${playlists.length} playlists from your Spotify Account`
    )

    await getItemsByPlaylists(authToken, playlists, sendLoadingMessageToClient, client.socketId)

    // Only do this when developing locally; you don't want this when it's a live server
    if (port === 8000) {
        fs.writeFileSync('../playlists.json', JSON.stringify(playlists, null, 2))
    }

    io.to(client.socketId).emit('readyForDownload', {
        body: generateReturnFile(playlists, client.fileType),
        fileType: client.fileType,
    })
})

io.on('connection', (socket) => {
    console.log(`Connected`)
    console.log(`Socket Id is: ${socket.id}`)

    let sessionId: string
    socket.on('sessionId', function (event) {
        if (!event.body) {
            throw new Error(`Incoming sessionId on Server is undefined`)
        }
        sessionId = event.body

        // first check if client exists already based on sessionId
        const matchingClients = clients.filter((client) => {
            return client.sessionId === sessionId
        })
        if (matchingClients.length > 1) {
            throw new Error(`Multiple clients with the same sessionId`)
        }
        if (matchingClients.length === 0) {
            clients.push({
                sessionId,
                socketId: socket.id,
            })
        } else {
            matchingClients[0].socketId = socket.id
        }
    })

    // clear client after 1 hour
    socket.on('disconnect', () => {
        console.log('user disconnected')
        setTimeout(function () {
            try {
                clients = clients.filter(function (client) {
                    return client.socketId !== socket.id
                })
            } catch (error) {
                console.log(`Failed to remove client after timeout; socket Id: ${socket.id}`)
            }
        }, 3600000)
    })
})


app.get('/about', function (req, res) {
    res.sendFile(path.join(__dirname, '../public/views/about.html'))
})

server.listen(port, () => {
    console.log(`Server is up on port ${port}!`)
})

function sendLoadingMessageToClient(socketId, message: string) {
    io.to(socketId).emit('loadingMessage', {
        body: message,
    })
}
