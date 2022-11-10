// Tabletop Club Master Server
// Copyright (c) 2007-2021 Juan Linietsky, Ariel Manzur.
// Copyright (c) 2014-2021 Godot Engine contributors.
// Copyright (c) 2021-2022 Benjamin 'drwhut' Beddows.
//
// Permission is hereby granted, free of charge, to any person obtaining
// A copy of this software and associated documentation files (the
// "Software"), to deal in the Software without restriction, including
// Without limitation the rights to use, copy, modify, merge, publish,
// Distribute, sublicense, and/or sell copies of the Software, and to
// Permit persons to whom the Software is furnished to do so, subject to
// The following conditions:
//
// The above copyright notice and this permission notice shall be
// Included in all copies or substantial portions of the Software.
//
// THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND,
// EXPRESS OR IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF
// MERCHANTABILITY, FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT.
// IN NO EVENT SHALL THE AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY
// CLAIM, DAMAGES OR OTHER LIABILITY, WHETHER IN AN ACTION OF CONTRACT,
// TORT OR OTHERWISE, ARISING FROM, OUT OF OR IN CONNECTION WITH THE
// SOFTWARE OR THE USE OR OTHER DEALINGS IN THE SOFTWARE.

const WebSocket = require("ws");
const crypto = require("crypto");
const fs = require("fs");
const https = require("https");

const MAX_PEERS = 4096;
const MAX_PEERS_PER_ADDRESS = 10;
const MAX_LOBBIES = 1024;
const MAX_PAYLOAD = 10000; // 10 KB.
const PORT = 9080;
const ALPHABET = "ABCDEFGHIJKLMNOPQRSTUVWXYZ";

const NO_LOBBY_TIMEOUT = 1000;
const SEAL_CLOSE_TIMEOUT = 10000;
const RECONNECT_TIMEOUT = 5000;
const PING_INTERVAL = 10000;

const CODE_ERROR = 4000;
// CLIENT ONLY: const CODE_MASTER_UNREACHABLE = 4001;
const CODE_NO_LOBBY = 4002;
const CODE_HOST_DISCONNECTED = 4003;
const CODE_ONLY_HOST_CAN_SEAL = 4004;
const CODE_TOO_MANY_LOBBIES = 4005;
const CODE_ALREADY_IN_LOBBY = 4006;
const CODE_LOBBY_DOES_NOT_EXISTS = 4007;
const CODE_LOBBY_IS_SEALED = 4008;
const CODE_INVALID_FORMAT = 4009;
const CODE_NEED_LOBBY = 4010;
const CODE_SERVER_ERROR = 4011;
const CODE_INVALID_DEST = 4012;
const CODE_INVALID_CMD = 4013;
const CODE_TOO_MANY_PEERS = 4014;
const CODE_INVALID_TRANSFER_MODE = 4015;
const CODE_TOO_MANY_CONNECTIONS = 4016;
const CODE_RECONNECT_TOO_QUICKLY = 4017;

function randomInt (low, high) {
	return Math.floor(Math.random() * (high - low + 1) + low);
}

function randomId () {
	return Math.abs(new Int32Array(crypto.randomBytes(4).buffer)[0]);
}

function randomSecret () {
	let out = "";
	for (let i = 0; i < 4; i++) {
		out += ALPHABET[randomInt(0, ALPHABET.length - 1)];
	}
	return out;
}

const server = https.createServer({
	cert: fs.readFileSync("public.crt"),
	key: fs.readFileSync("private.pem")
});
const wss = new WebSocket.Server({
	backlog: MAX_PEERS,
	maxPayload: MAX_PAYLOAD,
	server
});

class ProtoError extends Error {
	constructor (code, message) {
		super(message);
		this.code = code;
	}
}

class Peer {
	constructor (id, ws) {
		this.id = id;
		this.ws = ws;
		this.lobby = "";
		// Close connection after 1 sec if client has not joined a lobby
		this.timeout = setTimeout(() => {
			if (!this.lobby) ws.close(CODE_NO_LOBBY);
		}, NO_LOBBY_TIMEOUT);
	}
}

class Lobby {
	constructor (name, host) {
		this.name = name;
		this.host = host;
		this.peers = [];
		this.sealed = false;
		this.closeTimer = -1;
	}
	getPeerId (peer) {
		if (this.host === peer.id) return 1;
		return peer.id;
	}
	join (peer) {
		const assigned = this.getPeerId(peer);
		peer.ws.send(`I: ${assigned}\n`);
		this.peers.forEach((p) => {
			p.ws.send(`N: ${assigned}\n`);
			peer.ws.send(`N: ${this.getPeerId(p)}\n`);
		});
		this.peers.push(peer);
	}
	leave (peer) {
		const idx = this.peers.findIndex((p) => peer === p);
		if (idx === -1) return false;
		const assigned = this.getPeerId(peer);
		const close = assigned === 1;
		this.peers.forEach((p) => {
			// Room host disconnected, must close.
			if (close) p.ws.close(CODE_HOST_DISCONNECTED);
			// Notify peer disconnect.
			else p.ws.send(`D: ${assigned}\n`);
		});
		this.peers.splice(idx, 1);
		if (close && this.closeTimer >= 0) {
			// We are closing already.
			clearTimeout(this.closeTimer);
			this.closeTimer = -1;
		}
		return close;
	}
	seal (peer) {
		// Only host can seal
		if (peer.id !== this.host) {
			throw new ProtoError(CODE_ONLY_HOST_CAN_SEAL);
		}
		this.sealed = true;
		this.peers.forEach((p) => {
			p.ws.send("S: \n");
		});
		console.log(`Peer ${peer.id} sealed lobby ${this.name} ` +
			`with ${this.peers.length} peers`);
		this.closeTimer = setTimeout(() => {
			// Close peer connection to host (and thus the lobby)
			this.peers.forEach((p) => {
				p.ws.close(1000, "Seal completed.");
			});
		}, SEAL_CLOSE_TIMEOUT);
	}
}

const lobbies = new Map();
let peersCount = 0;

function joinLobby (peer, pLobby) {
	let lobbyName = pLobby;
	if (lobbyName === "") {
		if (lobbies.size >= MAX_LOBBIES) {
			throw new ProtoError(CODE_TOO_MANY_LOBBIES);
		}
		// Peer must not already be in a lobby
		if (peer.lobby !== "") {
			throw new ProtoError(CODE_ALREADY_IN_LOBBY);
		}
		lobbyName = randomSecret();
		lobbies.set(lobbyName, new Lobby(lobbyName, peer.id));
		console.log(`Peer ${peer.id} created lobby ${lobbyName}`);
		console.log(`Open lobbies: ${lobbies.size}`);
	}
	const lobby = lobbies.get(lobbyName);
	if (!lobby) throw new ProtoError(CODE_LOBBY_DOES_NOT_EXISTS);
	if (lobby.sealed) throw new ProtoError(CODE_LOBBY_IS_SEALED);
	peer.lobby = lobbyName;
	console.log(`Peer ${peer.id} joining lobby ${lobbyName} ` +
		`with ${lobby.peers.length} peers`);
	lobby.join(peer);
	peer.ws.send(`J: ${lobbyName}\n`);
}

function parseMsg (peer, msg) {
	const sep = msg.indexOf("\n");
	if (sep < 0) throw new ProtoError(CODE_INVALID_FORMAT);

	const cmd = msg.slice(0, sep);
	if (cmd.length < 3) throw new ProtoError(CODE_INVALID_FORMAT);

	const data = msg.slice(sep);

	// Lobby joining.
	if (cmd.startsWith("J: ")) {
		joinLobby(peer, cmd.substr(3).trim());
		return;
	}

	if (!peer.lobby) throw new ProtoError(CODE_NEED_LOBBY);
	const lobby = lobbies.get(peer.lobby);
	if (!lobby) throw new ProtoError(CODE_SERVER_ERROR);

	// Lobby sealing.
	if (cmd.startsWith("S: ")) {
		lobby.seal(peer);
		return;
	}

	// Message relaying format:
	//
	// [O|A|C]: DEST_ID\n
	// PAYLOAD
	//
	// O: Client is sending an offer.
	// A: Client is sending an answer.
	// C: Client is sending a candidate.
	let destId = parseInt(cmd.substr(3).trim());
	// Dest is not an ID.
	if (!destId) throw new ProtoError(CODE_INVALID_DEST);
	if (destId === 1) destId = lobby.host;
	const dest = lobby.peers.find((e) => e.id === destId);
	// Dest is not in this room.
	if (!dest) throw new ProtoError(CODE_INVALID_DEST);

	function isCmd (what) {
		return cmd.startsWith(`${what}: `);
	}
	if (isCmd("O") || isCmd("A") || isCmd("C")) {
		dest.ws.send(cmd[0] + ": " + lobby.getPeerId(peer) + data);
		return;
	}
	throw new ProtoError(CODE_INVALID_CMD);
}

function heartbeat () {
	this.isAlive = true;
}

const addressCount = new Map();
const reconnectTimer = new Map();

wss.on("connection", (ws, req) => {
	if (peersCount >= MAX_PEERS) {
		ws.close(CODE_TOO_MANY_PEERS);
		return;
	}

	const address = req.socket.remoteAddress;
	if (addressCount.has(address)) {
		const count = addressCount.get(address);
		if (count + 1 > MAX_PEERS_PER_ADDRESS) {
			ws.close(CODE_TOO_MANY_CONNECTIONS);
			return;
		}

		addressCount.set(address, count + 1);
	} else {
		addressCount.set(address, 1);
	}

	if (reconnectTimer.has(address)) {
		const lastDisconnect = reconnectTimer.get(address);
		const thisReconnect = new Date();
		const timeSinceDisconnect = thisReconnect - lastDisconnect;

		if (timeSinceDisconnect < RECONNECT_TIMEOUT) {
			ws.close(CODE_RECONNECT_TOO_QUICKLY);
			return;
		}

		reconnectTimer.delete(address);
	}

	ws.isAlive = true;
	ws.on("pong", heartbeat);

	peersCount++;
	const id = randomId();
	const peer = new Peer(id, ws);
	ws.on("message", (message) => {
		if (typeof message !== "string") {
			ws.close(CODE_INVALID_TRANSFER_MODE);
			return;
		}
		try {
			parseMsg(peer, message);
		} catch (e) {
			const code = e.code || CODE_ERROR;
			console.log(`Error parsing message from ${id}:\n` +
				message);
			ws.close(code, e.message);
		}
	});
	ws.on("close", (code, reason) => {
		peersCount--;

		if (addressCount.has(address)) {
			const count = addressCount.get(address);
			if (count <= 1) {
				addressCount.delete(address);
			} else {
				addressCount.set(address, count - 1);
			}
		}

		reconnectTimer.set(address, new Date());

		console.log(`Connection with peer ${peer.id} closed ` +
			`with reason ${code}: ${reason}`);
		if (peer.lobby && lobbies.has(peer.lobby) &&
			lobbies.get(peer.lobby).leave(peer)) {
			lobbies.delete(peer.lobby);
			console.log(`Deleted lobby ${peer.lobby}`);
			console.log(`Open lobbies: ${lobbies.size}`);
			peer.lobby = "";
		}
		if (peer.timeout >= 0) {
			clearTimeout(peer.timeout);
			peer.timeout = -1;
		}
	});
	ws.on("error", (error) => {
		console.error(error);
	});
});

const interval = setInterval(() => { // eslint-disable-line no-unused-vars
	wss.clients.forEach((ws) => {
		if (ws.isAlive === false) {
			ws.terminate();
		} else {
			ws.isAlive = false;
			ws.ping();
		}
	});

	const currentTime = new Date();
	reconnectTimer.forEach((disconnectTime, address, map) => {
		const timeSinceDisconnect = currentTime - disconnectTime;
		if (timeSinceDisconnect > RECONNECT_TIMEOUT) {
			map.delete(address);
		}
	});
}, PING_INTERVAL);

server.listen(PORT);
