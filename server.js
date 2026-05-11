const WebSocket = require('ws');
const PORT = process.env.PORT || 8080;

const server = new WebSocket.Server({ port: PORT }, () => {
    console.log(`Сервер запущен на порту ${PORT}`);
});

let lobby = []; // Игроки, которые сейчас ищут игру
let activeGames = new Map(); // Активные игровые комнаты

server.on('connection', (ws) => {
    ws.id = 'player_' + Math.random().toString(36).substr(2, 9);
    ws.username = "КРАСТЕР";
    ws.trophies = 0;
    ws.state = "menu"; // menu, searching, ingame

    console.log(`Подключился игрок: ${ws.id}`);

    ws.on('message', (message) => {
        try {
            const data = JSON.parse(message);

            switch(data.type) {
                case 'join_search':
                    ws.username = data.username || "КРАСТЕР";
                    ws.trophies = data.trophies || 0;
                    ws.state = "searching";
                    
                    if (!lobby.includes(ws)) {
                        lobby.push(ws);
                    }
                    broadcastLobbyCount();
                    checkLobbyReady();
                    break;

                case 'leave_search':
                    removeUserFromLobby(ws);
                    broadcastLobbyCount();
                    break;

                case 'game_update':
                    // Пересылаем координаты и действия игрока всем остальным в его комнате
                    if (ws.gameId && activeGames.has(ws.gameId)) {
                        const gameRoom = activeGames.get(ws.gameId);
                        gameRoom.players.forEach(client => {
                            if (client.id !== ws.id && client.readyState === WebSocket.OPEN) {
                                client.send(JSON.stringify({
                                    type: 'opponent_update',
                                    id: ws.id,
                                    x: data.x,
                                    z: data.z,
                                    hp: data.hp,
                                    rotY: data.rotY,
                                    powerups: data.powerups,
                                    isDead: data.isDead
                                }));
                            }
                        });
                    }
                    break;

                case 'shoot':
                    if (ws.gameId && activeGames.has(ws.gameId)) {
                        const gameRoom = activeGames.get(ws.gameId);
                        gameRoom.players.forEach(client => {
                            if (client.id !== ws.id && client.readyState === WebSocket.OPEN) {
                                client.send(JSON.stringify({
                                    type: 'opponent_shoot',
                                    id: ws.id,
                                    dirX: data.dirX,
                                    dirZ: data.dirZ
                                }));
                            }
                        });
                    }
                    break;
            }
        } catch (e) {
            console.error("Ошибка обработки сообщения:", e);
        }
    });

    ws.on('close', () => {
        console.log(`Игрок отключился: ${ws.id}`);
        removeUserFromLobby(ws);
        broadcastLobbyCount();
        
        // Если игрок ливнул во время катки
        if (ws.gameId && activeGames.has(ws.gameId)) {
            const gameRoom = activeGames.get(ws.gameId);
            gameRoom.players = gameRoom.players.filter(c => c.id !== ws.id);
            if (gameRoom.players.length === 0) {
                activeGames.delete(ws.gameId);
            }
        }
    });
});

function removeUserFromLobby(ws) {
    lobby = lobby.filter(client => client.id !== ws.id);
    ws.state = "menu";
}

function broadcastLobbyCount() {
    const count = lobby.length;
    lobby.forEach(client => {
        if (client.readyState === WebSocket.OPEN) {
            client.send(JSON.stringify({
                type: 'lobby_update',
                count: count
            }));
        }
    });
}

function checkLobbyReady() {
    // Если набралось хотя бы 2 реальных игрока (или 1 для теста, но сделаем запуск при заполнении)
    // Давай сделаем автозапуск, когда наберется группа, либо симуляцию до 15.
    if (lobby.length >= 2) { 
        startGameInstance();
    }
}

function startGameInstance() {
    const gameId = 'game_' + Math.random().toString(36).substr(2, 9);
    const roomPlayers = [...lobby];
    lobby = []; // Очищаем лобби для следующих

    activeGames.set(gameId, {
        id: gameId,
        players: roomPlayers
    });

    // Распределяем спавн-поинты по кругу для реальных игроков
    roomPlayers.forEach((client, index) => {
        client.gameId = gameId;
        client.state = "ingame";
        
        if (client.readyState === WebSocket.OPEN) {
            client.send(JSON.stringify({
                type: 'game_start',
                gameId: gameId,
                playerIndex: index,
                totalRealPlayers: roomPlayers.length,
                opponents: roomPlayers.map(p => ({ id: p.id, username: p.username, trophies: p.trophies }))
            }));
        }
    });
}
