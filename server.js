const express = require('express');
const http = require('http');
const socketIo = require('socket.io');
const sqlite3 = require('sqlite3').verbose();
const path = require('path');

const app = express();
const server = http.createServer(app);
const io = socketIo(server);

const PORT = process.env.PORT || 3000;

// Инициализация локальной базы данных SQLite
const dbPath = path.join(__dirname, 'database.sqlite');
const db = new sqlite3.Database(dbPath, (err) => {
    if (err) console.error('Ошибка подключения к БД:', err.message);
    else console.log('Подключено к локальной БД SQLite.');
});

// Создание таблиц пользователей
db.serialize(() => {
    db.run(`CREATE TABLE IF NOT EXISTS users (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        username TEXT UNIQUE,
        elo INTEGER DEFAULT 0
    )`);
});

// Автопингер для Render
const RENDER_EXTERNAL_URL = process.env.RENDER_EXTERNAL_URL;
if (RENDER_EXTERNAL_URL) {
    setInterval(() => {
        http.get(RENDER_EXTERNAL_URL, (res) => {
            console.log(`[Auto-Pinger] Пинг выполнен: ${res.statusCode}`);
        }).on('error', (err) => {
            console.error('[Auto-Pinger] Ошибка пинга:', err.message);
        });
    }, 10 * 60 * 1000);
}

// Отдача фронтенда напрямую из сервера
app.get('/', (req, res) => {
    res.send(getHTMLClient());
});

// Состояние комнат и очередей
const matchmakingQueue = [];
const activeGames = {};
const onlineUsers = {}; // socket.id -> { username, elo }

io.on('connection', (socket) => {
    console.log(`Пользователь подключился: ${socket.id}`);

    // Авторизация/Вход
    socket.on('join', (username) => {
        const cleanName = username.trim().substring(0, 15) || `Игрок_${Math.floor(Math.random() * 9000 + 1000)}`;
        
        db.get("SELECT elo FROM users WHERE username = ?", [cleanName], (err, row) => {
            let elo = 0;
            if (row) {
                elo = row.elo;
                loginUser(socket, cleanName, elo);
            } else {
                db.run("INSERT INTO users (username, elo) VALUES (?, 0)", [cleanName], function(err) {
                    if (err) {
                        db.get("SELECT elo FROM users WHERE username = ?", [cleanName], (err, row2) => {
                            loginUser(socket, cleanName, row2 ? row2.elo : 0);
                        });
                    } else {
                        loginUser(socket, cleanName, 0);
                    }
                });
            }
        });
    });

    // Обработка сообщений глобального чата
    socket.on('chat_message', (msg) => {
        const user = onlineUsers[socket.id];
        if (!user) return;
        const cleanMsg = msg.trim().substring(0, 100);
        if (cleanMsg.length === 0) return;

        io.emit('chat_broadcast', {
            username: user.username,
            message: cleanMsg
        });
    });

    // Поиск онлайн-игры
    socket.on('find_match', () => {
        const user = onlineUsers[socket.id];
        if (!user) return;

        if (matchmakingQueue.find(p => p.socketId === socket.id)) return;

        matchmakingQueue.push({ socketId: socket.id, username: user.username, elo: user.elo });
        socket.emit('searching_match');

        checkMatchmaking();
    });

    socket.on('cancel_search', () => {
        const index = matchmakingQueue.findIndex(p => p.socketId === socket.id);
        if (index !== -1) {
            matchmakingQueue.splice(index, 1);
            socket.emit('search_cancelled');
        }
    });

    // Ход игрока
    socket.on('make_move', (move) => {
        const gameId = socket.gameId;
        if (!gameId || !activeGames[gameId]) return;

        const game = activeGames[gameId];
        const isPlayer1 = game.p1.socketId === socket.id;
        const player = isPlayer1 ? game.p1 : game.p2;

        if (game.roundState === 'waiting_moves' && !player.currentMove) {
            player.currentMove = move;
            
            if (game.p1.currentMove && game.p2.currentMove) {
                processRound(game);
            }
        }
    });

    // Отключение пользователя
    socket.on('disconnect', () => {
        console.log(`Пользователь отключился: ${socket.id}`);
        
        const qIndex = matchmakingQueue.findIndex(p => p.socketId === socket.id);
        if (qIndex !== -1) matchmakingQueue.splice(qIndex, 1);

        const gameId = socket.gameId;
        if (gameId && activeGames[gameId]) {
            const game = activeGames[gameId];
            const opponentSocketId = game.p1.socketId === socket.id ? game.p2.socketId : game.p1.socketId;
            const oppSocket = io.sockets.sockets.get(opponentSocketId);
            
            if (oppSocket) {
                oppSocket.emit('opponent_disconnected');
                updateElo(onlineUsers[opponentSocketId].username, 20, (newElo) => {
                    onlineUsers[opponentSocketId].elo = newElo;
                    oppSocket.emit('elo_updated', newElo);
                    sendLeaderboard();
                });
            }
            delete activeGames[gameId];
        }

        delete onlineUsers[socket.id];
        sendLeaderboard();
    });
});

function loginUser(socket, username, elo) {
    onlineUsers[socket.id] = { username, elo };
    socket.emit('auth_success', { username, elo });
    sendLeaderboard();
}

function sendLeaderboard() {
    db.all("SELECT username, elo FROM users ORDER BY elo DESC LIMIT 10", [], (err, rows) => {
        if (!err) {
            io.emit('update_leaderboard', {
                leaderboard: rows,
                onlineCount: Object.keys(onlineUsers).length
            });
        }
    });
}

function checkMatchmaking() {
    if (matchmakingQueue.length >= 2) {
        const p1 = matchmakingQueue.shift();
        const p2 = matchmakingQueue.shift();

        const gameId = `game_${Date.now()}_${Math.random().toString(36).substr(2, 5)}`;
        
        const p1Socket = io.sockets.sockets.get(p1.socketId);
        const p2Socket = io.sockets.sockets.get(p2.socketId);

        if (!p1Socket || !p2Socket) {
            if (p1Socket) matchmakingQueue.unshift(p1);
            if (p2Socket) matchmakingQueue.unshift(p2);
            return;
        }

        p1Socket.gameId = gameId;
        p2Socket.gameId = gameId;

        activeGames[gameId] = {
            id: gameId,
            p1: { socketId: p1.socketId, username: p1.username, elo: p1.elo, wins: 0, currentMove: null },
            p2: { socketId: p2.socketId, username: p2.username, elo: p2.elo, wins: 0, currentMove: null },
            roundsPlayed: 0,
            roundHistory: [],
            roundState: 'loading'
        };

        io.to(p1.socketId).emit('match_found', { opponent: { username: p2.username, elo: p2.elo }, role: 'p1' });
        io.to(p2.socketId).emit('match_found', { opponent: { username: p1.username, elo: p1.elo }, role: 'p2' });

        setTimeout(() => {
            startRound(activeGames[gameId]);
        }, 5000);
    }
}

function startRound(game) {
    if (!game) return;
    game.roundState = 'waiting_moves';
    game.p1.currentMove = null;
    game.p2.currentMove = null;

    io.to(game.p1.socketId).emit('start_round', { roundNum: game.roundsPlayed + 1, score: [game.p1.wins, game.p2.wins] });
    io.to(game.p2.socketId).emit('start_round', { roundNum: game.roundsPlayed + 1, score: [game.p2.wins, game.p1.wins] });

    game.roundTimer = setTimeout(() => {
        if (game.roundState === 'waiting_moves') {
            if (!game.p1.currentMove && !game.p2.currentMove) {
                game.p1.currentMove = 'none';
                game.p2.currentMove = 'none';
            } else if (!game.p1.currentMove) {
                game.p1.currentMove = 'none';
            } else if (!game.p2.currentMove) {
                game.p2.currentMove = 'none';
            }
            processRound(game);
        }
    }, 10500);
}

function processRound(game) {
    if (game.roundTimer) clearTimeout(game.roundTimer);
    game.roundState = 'animating';

    const m1 = game.p1.currentMove;
    const m2 = game.p2.currentMove;

    let result = 'draw';

    if (m1 === 'none' && m2 === 'none') {
        result = 'draw';
    } else if (m1 === 'none') {
        result = 'p2';
    } else if (m2 === 'none') {
        result = 'p1';
    } else if (m1 !== m2) {
        if (
            (m1 === 'rock' && m2 === 'scissors') ||
            (m1 === 'scissors' && m2 === 'paper') ||
            (m1 === 'paper' && m2 === 'rock')
        ) {
            result = 'p1';
        } else {
            result = 'p2';
        }
    }

    if (result === 'p1') game.p1.wins++;
    if (result === 'p2') game.p2.wins++;
    
    game.roundsPlayed++;
    game.roundHistory.push(result);

    io.to(game.p1.socketId).emit('round_result', { myMove: m1, oppMove: m2, result: result === 'p1' ? 'win' : (result === 'p2' ? 'lose' : 'draw'), score: [game.p1.wins, game.p2.wins] });
    io.to(game.p2.socketId).emit('round_result', { myMove: m2, oppMove: m1, result: result === 'p2' ? 'win' : (result === 'p1' ? 'lose' : 'draw'), score: [game.p2.wins, game.p1.wins] });

    setTimeout(() => {
        const isMatchOver = game.p1.wins >= 2 || game.p2.wins >= 2 || game.roundsPlayed >= 3;

        if (isMatchOver) {
            endMatch(game);
        } else {
            startRound(game);
        }
    }, 4500);
}

function endMatch(game) {
    let matchWinner = 'draw';
    if (game.p1.wins > game.p2.wins) matchWinner = 'p1';
    else if (game.p2.wins > game.p1.wins) matchWinner = 'p2';

    let p1EloChange = 0;
    let p2EloChange = 0;

    if (matchWinner === 'p1') {
        p1EloChange = 25;
        p2EloChange = -15;
    } else if (matchWinner === 'p2') {
        p1EloChange = -15;
        p2EloChange = 25;
    }

    const applyEloChange = (username, change, callback) => {
        updateElo(username, change, callback);
    };

    applyEloChange(game.p1.username, p1EloChange, (newElo1) => {
        applyEloChange(game.p2.username, p2EloChange, (newElo2) => {
            const p1Socket = io.sockets.sockets.get(game.p1.socketId);
            const p2Socket = io.sockets.sockets.get(game.p2.socketId);

            if (p1Socket) {
                onlineUsers[game.p1.socketId].elo = newElo1;
                p1Socket.emit('match_end', { result: matchWinner === 'p1' ? 'win' : (matchWinner === 'p2' ? 'lose' : 'draw'), eloChange: p1EloChange, newElo: newElo1 });
                p1Socket.gameId = null;
            }
            if (p2Socket) {
                onlineUsers[game.p2.socketId].elo = newElo2;
                p2Socket.emit('match_end', { result: matchWinner === 'p2' ? 'win' : (matchWinner === 'p1' ? 'lose' : 'draw'), eloChange: p2EloChange, newElo: newElo2 });
                p2Socket.gameId = null;
            }

            delete activeGames[game.id];
            sendLeaderboard();
        });
    });
}

function updateElo(username, change, callback) {
    db.get("SELECT elo FROM users WHERE username = ?", [username], (err, row) => {
        let currentElo = row ? row.elo : 0;
        let newElo = currentElo + change;
        if (newElo < 0) newElo = 0;

        db.run("UPDATE users SET elo = ? WHERE username = ?", [newElo, username], (err) => {
            callback(newElo);
        });
    });
}

server.listen(PORT, () => {
    console.log(`Сервер запущен на порту ${PORT}`);
});

function getHTMLClient() {
    return `
<!DOCTYPE html>
<html lang="ru">
<head>
    <meta charset="UTF-8">
    <meta name="viewport" content="width=device-width, initial-scale=1.0, maximum-scale=1.0, user-scalable=no">
    <title>Brawl Knuckles 3D</title>
    <script src="https://cdnjs.cloudflare.com/ajax/libs/three.js/r128/three.min.js"></script>
    <script src="https://cdnjs.cloudflare.com/ajax/libs/gsap/3.12.2/gsap.min.js"></script>
    <script src="/socket.io/socket.io.js"></script>
    <style>
        * { box-sizing: border-box; margin: 0; padding: 0; user-select: none; font-family: 'Arial Black', Impact, sans-serif; }
        body, html { width: 100%; height: 100%; overflow: hidden; background: #120136; color: #fff; }

        .screen {
            position: absolute; width: 100%; height: 100%; top: 0; left: 0;
            display: none; flex-direction: column; justify-content: space-between; align-items: center;
            padding: 20px; z-index: 10;
        }
        .active-screen { display: flex !important; }

        #auth-screen {
            background: linear-gradient(135deg, #1f1c2c, #928dab);
            justify-content: center; gap: 20px;
        }
        .brawl-input {
            padding: 15px 25px; border-radius: 25px; border: 4px solid #fff;
            font-size: 20px; text-align: center; width: 280px; outline: none;
            box-shadow: 0 8px 0 #4a4a4a;
        }
        .brawl-btn {
            background: linear-gradient(#ffcb05, #f58220);
            border: 4px solid #fff; border-radius: 25px;
            color: #fff; font-size: 22px; padding: 12px 35px;
            text-shadow: 2px 2px 0 #000; box-shadow: 0 8px 0 #a04000, 0 15px 20px rgba(0,0,0,0.4);
            cursor: pointer; transform: scale(1); transition: transform 0.1s;
        }
        .brawl-btn:active { transform: translateY(6px); box-shadow: 0 2px 0 #a04000; }

        #menu-screen {
            background: radial-gradient(circle, #2d0066 0%, #0d001a 100%);
        }

        .trophy-container {
            position: absolute; top: 15px; left: 15px;
            background: linear-gradient(to right, #202020, #3e3e3e);
            border: 3px solid #ffcb05; border-radius: 30px;
            display: flex; align-items: center; padding: 5px 20px 5px 45px;
            box-shadow: 0 5px 0 #000;
        }
        .trophy-icon {
            position: absolute; left: -10px; width: 45px; height: 45px;
            background: radial-gradient(#ffe066, #f58220);
            border-radius: 50%; border: 3px solid #fff;
            display: flex; align-items: center; justify-content: center; font-size: 22px;
        }
        .trophy-count { font-size: 24px; color: #fff; font-weight: bold; text-shadow: 2px 2px #000; }

        .play-btn-container { position: absolute; bottom: 30px; right: 30px; }
        .play-btn {
            background: linear-gradient(#f05a28, #e00000);
            padding: 20px 60px; font-size: 28px; border-radius: 35px;
        }

        .chat-toggle {
            position: absolute; right: 30px; top: 30px;
            background: #0088cc; border: 3px solid #fff; border-radius: 50%;
            width: 60px; height: 60px; display: flex; align-items: center; justify-content: center;
            font-size: 28px; cursor: pointer; box-shadow: 0 5px 0 #005580;
        }
        .chat-panel {
            position: absolute; right: -350px; top: 0; width: 320px; height: 100%;
            background: rgba(0, 77, 153, 0.95); border-left: 5px solid #00bbff;
            z-index: 100; display: flex; flex-direction: column; padding: 15px;
            transition: right 0.3s ease; box-shadow: -10px 0 20px rgba(0,0,0,0.5);
        }
        .chat-panel.open { right: 0; }
        .chat-header { 
            font-size: 20px; margin-bottom: 10px; border-bottom: 2px solid #00bbff; 
            padding-bottom: 5px; display: flex; justify-content: space-between; align-items: center;
        }
        .chat-close-btn {
            cursor: pointer; font-size: 20px; color: #ff3333; background: none; border: none; font-weight: bold;
        }
        .chat-messages { flex-grow: 1; overflow-y: auto; display: flex; flex-direction: column; gap: 8px; margin-bottom: 10px; }
        .chat-msg { background: rgba(0,0,0,0.3); padding: 8px 12px; border-radius: 12px; font-size: 14px; word-break: break-word; }
        .chat-msg span { color: #ffcb05; }
        .chat-input-area { display: flex; gap: 5px; }
        .chat-input { flex-grow: 1; padding: 10px; border-radius: 10px; border: none; font-size: 14px; }

        .leaderboard-panel {
            position: absolute; left: 15px; top: 80px; width: 240px; max-height: 50%;
            background: rgba(0,0,0,0.6); border: 2px solid #3e3e3e; border-radius: 15px;
            padding: 10px; overflow-y: auto; font-size: 14px;
        }
        .leaderboard-title { color: #ffcb05; margin-bottom: 5px; border-bottom: 1px solid #ffcb05; }
        .leaderboard-row { display: flex; justify-content: space-between; padding: 3px 0; }

        .modal-overlay {
            position: absolute; width: 100%; height: 100%; background: rgba(0,0,0,0.8);
            z-index: 200; display: none; align-items: center; justify-content: center;
        }
        .mode-selection {
            background: #202020; border: 4px solid #fff; border-radius: 30px;
            padding: 30px; display: flex; flex-direction: column; gap: 20px; align-items: center;
            box-shadow: 0 10px 0 #000;
        }

        #game-screen { background: #0d001a; }
        #canvas-3d-container { position: absolute; width: 100%; height: 100%; top: 0; left: 0; z-index: 1; }

        .game-ui { position: absolute; width: 100%; height: 100%; top: 0; left: 0; z-index: 5; pointer-events: none; display: flex; flex-direction: column; justify-content: space-between; padding: 20px; }
        .hud-header { display: flex; justify-content: space-between; align-items: center; width: 100%; }
        
        .knockout-rounds { display: flex; gap: 8px; background: rgba(0,0,0,0.5); padding: 5px 15px; border-radius: 20px; }
        .ko-circle { width: 24px; height: 24px; border-radius: 50%; border: 2px solid #fff; background: #333; }
        .ko-blue.active { background: #0088ff; box-shadow: 0 0 10px #0088ff; }
        .ko-red.active { background: #ff3333; box-shadow: 0 0 10px #ff3333; }

        /* Понятная шпаргалка правил */
        .rules-bar {
            background: rgba(0,0,0,0.7); border: 2px solid #ffcb05; border-radius: 15px;
            padding: 6px 15px; font-size: 14px; text-align: center; color: #fff;
            box-shadow: 0 4px 10px rgba(0,0,0,0.5); text-shadow: 1px 1px 0 #000;
            display: inline-block; margin-bottom: 5px; pointer-events: none;
        }

        .game-controls-container {
            display: flex; flex-direction: column; align-items: center; justify-content: center;
            width: 100%; pointer-events: auto;
        }

        .game-controls { display: flex; gap: 15px; justify-content: center; margin-bottom: 10px; width: 100%; }
        .control-btn {
            width: 90px; height: 90px; border-radius: 50%; border: 4px solid #fff;
            display: flex; flex-direction: column; align-items: center; justify-content: center;
            font-size: 32px; cursor: pointer; background: #e00000;
            box-shadow: 0 6px 0 #800000, 0 10px 15px rgba(0,0,0,0.5);
            transition: transform 0.1s;
        }
        .control-btn:active { transform: translateY(4px); box-shadow: 0 2px 0 #800000; }
        .control-btn[data-move="rock"] { background: linear-gradient(#5bc0de, #2f96b4); box-shadow: 0 6px 0 #1f6b80; }
        .control-btn[data-move="paper"] { background: linear-gradient(#62c462, #51a351); box-shadow: 0 6px 0 #387338; }
        .control-btn[data-move="scissors"] { background: linear-gradient(#fbb450, #f89406); box-shadow: 0 6px 0 #ad6704; }

        .timer-bar-container { width: 250px; height: 20px; background: #333; border: 3px solid #fff; border-radius: 10px; overflow: hidden; pointer-events: none; }
        .timer-bar { width: 100%; height: 100%; background: #ffcb05; transition: width 0.1s linear; }

        .overlay-result {
            position: absolute; width: 100%; height: 100%; background: rgba(0,0,0,0.85);
            z-index: 300; display: none; flex-direction: column; align-items: center; justify-content: center;
            text-align: center;
        }
        .result-title { font-size: 64px; text-shadow: 4px 4px 0 #000; font-weight: 900; transform: scale(0.5); opacity: 0; }
        .result-title.win { color: #ffcb05; }
        .result-title.lose { color: #ff3333; }
        .result-title.draw { color: #cccccc; }

        @media (max-width: 768px) {
            .leaderboard-panel { display: none; }
            .chat-panel { width: 260px; }
            .play-btn { padding: 15px 40px; font-size: 22px; }
            .control-btn { width: 70px; height: 70px; font-size: 24px; }
            .rules-bar { font-size: 11px; padding: 4px 10px; }
        }
    </style>
</head>
<body>

    <div id="auth-screen" class="screen active-screen">
        <h1 style="font-size: 42px; text-shadow: 3px 3px 0 #000; text-align: center;">BRAWL KNUCKLES</h1>
        <input type="text" id="username-input" class="brawl-input" placeholder="Введите ваш ник..." maxlength="15">
        <button id="login-btn" class="brawl-btn">ВОЙТИ В ИГРУ</button>
    </div>

    <div id="menu-screen" class="screen">
        <div class="trophy-container">
            <div class="trophy-icon">🏆</div>
            <div id="user-elo" class="trophy-count">0</div>
        </div>

        <div id="online-counter" style="position: absolute; top: 15px; left: 180px; font-size: 16px; text-shadow: 1px 1px #000;">Онлайн: 0</div>

        <div class="leaderboard-panel">
            <div class="leaderboard-title">ТОП ИГРОКОВ</div>
            <div id="leaderboard-rows"></div>
        </div>

        <div id="chat-toggle-btn" class="chat-toggle">💬</div>

        <div id="chat-panel" class="chat-panel">
            <div class="chat-header">
                <span>Глобальный Чат</span>
                <button id="chat-close-btn" class="chat-close-btn">✖</button>
            </div>
            <div id="chat-messages" class="chat-messages"></div>
            <div class="chat-input-area">
                <input type="text" id="chat-input" class="chat-input" placeholder="Сообщение..." maxlength="80">
                <button id="send-chat-btn" class="brawl-btn" style="padding: 10px; font-size: 14px; border-radius: 10px;">➔</button>
            </div>
        </div>

        <div id="menu-3d-bg" style="position: absolute; width: 100%; height: 100%; top: 0; left: 0; z-index: 0; pointer-events: none;"></div>

        <div class="play-btn-container" style="z-index: 10;">
            <button id="play-trigger" class="brawl-btn play-btn">ИГРАТЬ</button>
        </div>
    </div>

    <div id="mode-modal" class="modal-overlay">
        <div class="mode-selection">
            <h2 style="font-size: 24px; text-shadow: 2px 2px #000;">ВЫБЕРИТЕ РЕЖИМ</h2>
            <button id="mode-offline" class="brawl-btn" style="background: linear-gradient(#5bc0de, #2f96b4);">ПРОТИВ БОТА (БЫСТРО)</button>
            <button id="mode-online" class="brawl-btn">ОНЛАЙН (РЕЙТИНГ)</button>
            <button id="close-modal" class="brawl-btn" style="background: #333; font-size: 14px; padding: 5px 15px;">НАЗАД</button>
        </div>
    </div>

    <div id="game-screen" class="screen">
        <div id="canvas-3d-container"></div>

        <div class="game-ui">
            <div class="hud-header">
                <div style="text-align: left; background: rgba(0,0,255,0.3); padding: 5px 15px; border-radius: 15px; border: 2px solid #0088ff;">
                    <div id="game-p1-name" style="text-shadow: 2px 2px #000; font-size: 16px;">Вы</div>
                    <div class="knockout-rounds">
                        <div class="ko-circle ko-blue" id="p1-round-1"></div>
                        <div class="ko-circle ko-blue" id="p1-round-2"></div>
                    </div>
                </div>

                <div style="display: flex; flex-direction: column; align-items: center;">
                    <div id="game-round-title" style="font-size: 22px; text-shadow: 2px 2px #000; margin-bottom: 5px;">РАУНД 1</div>
                    <div class="timer-bar-container"><div id="game-timer-bar" class="timer-bar"></div></div>
                </div>

                <div style="text-align: right; background: rgba(255,0,0,0.3); padding: 5px 15px; border-radius: 15px; border: 2px solid #ff3333;">
                    <div id="game-p2-name" style="text-shadow: 2px 2px #000; font-size: 16px;">Враг</div>
                    <div class="knockout-rounds" style="flex-direction: row-reverse;">
                        <div class="ko-circle ko-red" id="p2-round-1"></div>
                        <div class="ko-circle ko-red" id="p2-round-2"></div>
                    </div>
                </div>
            </div>

            <div class="game-controls-container">
                <div class="rules-bar">
                    ✊ бьёт ✌️ &nbsp;|&nbsp; ✌️ бьёт ✋ &nbsp;|&nbsp; ✋ бьёт ✊
                </div>
                <div class="game-controls">
                    <button class="control-btn" data-move="rock" title="Камень">✊</button>
                    <button class="control-btn" data-move="scissors" title="Ножницы">✌️</button>
                    <button class="control-btn" data-move="paper" title="Бумага">✋</button>
                </div>
            </div>
        </div>
    </div>

    <div id="result-overlay" class="overlay-result">
        <h1 id="result-text" class="result-title">ПОБЕДА!</h1>
        <p id="result-elo-detail" style="font-size: 24px; margin-top: 15px; text-shadow: 2px 2px #000;"></p>
        <button id="result-continue-btn" class="brawl-btn" style="margin-top: 30px;">ПРОДОЛЖИТЬ</button>
    </div>

    <script>
        const socket = io();
        let myUsername = '';
        let myElo = 0;
        let isOnlineMode = false;
        let botMode = false;

        const audioCtx = new (window.AudioContext || window.webkitAudioContext)();
        
        function playSound(type) {
            try {
                if (audioCtx.state === 'suspended') audioCtx.resume();
                const osc = audioCtx.createOscillator();
                const gain = audioCtx.createGain();
                osc.connect(gain);
                gain.connect(audioCtx.destination);

                if (type === 'click') {
                    osc.type = 'sine';
                    osc.frequency.setValueAtTime(600, audioCtx.currentTime);
                    osc.frequency.exponentialRampToValueAtTime(150, audioCtx.currentTime + 0.15);
                    gain.gain.setValueAtTime(0.1, audioCtx.currentTime);
                    gain.gain.linearRampToValueAtTime(0.01, audioCtx.currentTime + 0.15);
                    osc.start(); osc.stop(audioCtx.currentTime + 0.15);
                } else if (type === 'win') {
                    osc.type = 'triangle';
                    osc.frequency.setValueAtTime(261.63, audioCtx.currentTime);
                    osc.frequency.setValueAtTime(329.63, audioCtx.currentTime + 0.1);
                    osc.frequency.setValueAtTime(392.00, audioCtx.currentTime + 0.2);
                    osc.frequency.setValueAtTime(523.25, audioCtx.currentTime + 0.3);
                    gain.gain.setValueAtTime(0.15, audioCtx.currentTime);
                    gain.gain.linearRampToValueAtTime(0.01, audioCtx.currentTime + 0.5);
                    osc.start(); osc.stop(audioCtx.currentTime + 0.5);
                } else if (type === 'lose') {
                    osc.type = 'sawtooth';
                    osc.frequency.setValueAtTime(220, audioCtx.currentTime);
                    osc.frequency.exponentialRampToValueAtTime(80, audioCtx.currentTime + 0.4);
                    gain.gain.setValueAtTime(0.15, audioCtx.currentTime);
                    gain.gain.linearRampToValueAtTime(0.01, audioCtx.currentTime + 0.45);
                    osc.start(); osc.stop(audioCtx.currentTime + 0.45);
                } else if (type === 'clap') {
                    const bufferSize = audioCtx.sampleRate * 0.1;
                    const buffer = audioCtx.createBuffer(1, bufferSize, audioCtx.sampleRate);
                    const data = buffer.getChannelData(0);
                    for (let i = 0; i < bufferSize; i++) {
                        data[i] = Math.random() * 2 - 1;
                    }
                    const noise = audioCtx.createBufferSource();
                    noise.buffer = buffer;
                    const noiseFilter = audioCtx.createBiquadFilter();
                    noiseFilter.type = 'bandpass';
                    noiseFilter.frequency.value = 1000;
                    noise.connect(noiseFilter);
                    noiseFilter.connect(gain);
                    gain.gain.setValueAtTime(0.1, audioCtx.currentTime);
                    gain.gain.exponentialRampToValueAtTime(0.01, audioCtx.currentTime + 0.1);
                    noise.start(); noise.stop(audioCtx.currentTime + 0.1);
                }
            } catch (e) { console.log(e); }
        }

        let musicInterval;
        function startBackgroundMusic() {
            if (musicInterval) clearInterval(musicInterval);
            let beat = 0;
            musicInterval = setInterval(() => {
                try {
                    if (audioCtx.state === 'suspended') return;
                    beat++;
                    if (beat % 4 === 0) {
                        playSound('clap');
                        animateClapHand();
                    }
                    const osc = audioCtx.createOscillator();
                    const gain = audioCtx.createGain();
                    osc.connect(gain); gain.connect(audioCtx.destination);
                    osc.type = 'triangle';
                    const notes = [110, 110, 130, 146, 110, 110, 165, 146];
                    osc.frequency.setValueAtTime(notes[beat % notes.length], audioCtx.currentTime);
                    gain.gain.setValueAtTime(0.04, audioCtx.currentTime);
                    gain.gain.exponentialRampToValueAtTime(0.001, audioCtx.currentTime + 0.3);
                    osc.start(); osc.stop(audioCtx.currentTime + 0.3);
                } catch(e){}
            }, 350);
        }

        // --- THREE.JS СЦЕНА (МОДЕЛИ) ---
        let scene, camera, renderer, leftHand, rightHand;
        let menuScene, menuCamera, menuRenderer, menuHand;
        let clock = new THREE.Clock();

        function init3DMenu() {
            const container = document.getElementById('menu-3d-bg');
            if (!container) return;
            container.innerHTML = '';
            menuScene = new THREE.Scene();
            menuCamera = new THREE.PerspectiveCamera(45, container.clientWidth / container.clientHeight, 0.1, 100);
            menuCamera.position.set(0, 0, 5);

            menuRenderer = new THREE.WebGLRenderer({ alpha: true, antialias: true });
            menuRenderer.setSize(container.clientWidth, container.clientHeight);
            container.appendChild(menuRenderer.domElement);

            const ambientLight = new THREE.AmbientLight(0xffffff, 0.6);
            menuScene.add(ambientLight);
            const dirLight = new THREE.DirectionalLight(0xffffff, 0.8);
            dirLight.position.set(5, 5, 5);
            menuScene.add(dirLight);

            menuHand = createProceduralHand('#ffcb05');
            menuHand.position.set(0, -1, 0);
            menuHand.scale.set(1.5, 1.5, 1.5);
            menuScene.add(menuHand);

            animateMenu();
        }

        function createProceduralHand(colorStr) {
            const handGroup = new THREE.Group();
            const color = new THREE.Color(colorStr);
            const mat = new THREE.MeshStandardMaterial({ color: color, roughness: 0.5 });
            
            // Прямоугольная ладонь
            const palmGeom = new THREE.BoxGeometry(0.8, 0.8, 0.2);
            const palm = new THREE.Mesh(palmGeom, mat);
            handGroup.add(palm);

            // Четыре основных пальца (из звеньев, чтобы их можно было реалистично гнуть)
            const fingers = [];
            for (let i = 0; i < 4; i++) {
                const fingerPivot = new THREE.Group();
                fingerPivot.position.set(-0.3 + i * 0.2, 0.4, 0);
                fingerPivot.name = "finger_" + i;

                // Основное звено (Фаланга)
                const boneGeom = new THREE.BoxGeometry(0.16, 0.4, 0.16);
                const bone = new THREE.Mesh(boneGeom, mat);
                bone.position.y = 0.2; // Сдвиг центра, чтобы сгиб был у основания
                fingerPivot.add(bone);

                handGroup.add(fingerPivot);
            }

            // Большой палец (под углом)
            const thumbPivot = new THREE.Group();
            thumbPivot.position.set(-0.45, 0.1, 0.05);
            thumbPivot.rotation.z = 0.6;
            thumbPivot.name = "finger_thumb";

            const thumbBoneGeom = new THREE.BoxGeometry(0.18, 0.3, 0.16);
            const thumbBone = new THREE.Mesh(thumbBoneGeom, mat);
            thumbBone.position.y = 0.15;
            thumbPivot.add(thumbBone);
            handGroup.add(thumbPivot);

            return handGroup;
        }

        function animateMenu() {
            requestAnimationFrame(animateMenu);
            if (menuHand) {
                menuHand.rotation.y = Math.sin(Date.now() * 0.001) * 0.3;
            }
            if (menuRenderer && menuScene && menuCamera) {
                menuRenderer.render(menuScene, menuCamera);
            }
        }

        function animateClapHand() {
            if (!menuHand) return;
            gsap.to(menuHand.position, { y: -0.6, duration: 0.1, yoyo: true, repeat: 1 });
            gsap.to(menuHand.scale, { x: 1.7, y: 1.7, duration: 0.1, yoyo: true, repeat: 1 });
        }

        function init3DGame() {
            const container = document.getElementById('canvas-3d-container');
            container.innerHTML = '';
            
            scene = new THREE.Scene();
            camera = new THREE.PerspectiveCamera(45, container.clientWidth / container.clientHeight, 0.1, 100);
            camera.position.set(0, 0, 7);

            renderer = new THREE.WebGLRenderer({ antialias: true });
            renderer.setSize(container.clientWidth, container.clientHeight);
            container.appendChild(renderer.domElement);

            const ambientLight = new THREE.AmbientLight(0xffffff, 0.7);
            scene.add(ambientLight);
            const dirLight = new THREE.DirectionalLight(0xffffff, 1);
            dirLight.position.set(5, 10, 7);
            scene.add(dirLight);

            // Наша рука (Синяя, слева-снизу)
            leftHand = createProceduralHand('#0088ff');
            leftHand.position.set(-1.8, -1.5, 0);
            leftHand.rotation.set(0.3, 0.5, -0.2);
            scene.add(leftHand);

            // Рука противника (Красная, справа-сверху, развернутая)
            rightHand = createProceduralHand('#ff3333');
            rightHand.position.set(1.8, 1.5, 0);
            rightHand.rotation.set(-0.3, -2.5, 0.2);
            scene.add(rightHand);

            animateGame();
        }

        function animateGame() {
            requestAnimationFrame(animateGame);
            if (renderer && scene && camera) {
                renderer.render(scene, camera);
            }
        }

        function playShakeHandsAnimation() {
            if (!leftHand || !rightHand) return;
            
            resetHandFingers(leftHand);
            resetHandFingers(rightHand);

            const t = 0.3;
            for(let i=0; i<3; i++) {
                gsap.to(leftHand.position, { y: -0.8, duration: t, delay: i*t*2, yoyo: true, repeat: 1 });
                gsap.to(rightHand.position, { y: 0.8, duration: t, delay: i*t*2, yoyo: true, repeat: 1 });
            }
        }

        function showMoves3D(myMove, oppMove) {
            applyMoveToHand(leftHand, myMove);
            applyMoveToHand(rightHand, oppMove);

            gsap.to(leftHand.position, { z: 1.5, y: -0.5, duration: 0.3 });
            gsap.to(rightHand.position, { z: 1.5, y: 0.5, duration: 0.3 });
        }

        function resetHandFingers(hand) {
            hand.position.set(hand === leftHand ? -1.8 : 1.8, hand === leftHand ? -1.5 : 1.5, 0);
            hand.children.forEach(function(c) {
                if(c.name.startsWith('finger_')) {
                    c.rotation.x = 0;
                    c.rotation.z = (c.name === 'finger_thumb') ? 0.6 : 0;
                    c.visible = true;
                }
            });
        }

        // КРУТЫЕ МОДЕЛИ КАМЕНЬ / НОЖНИЦЫ / БУМАГА
        function applyMoveToHand(hand, move) {
            hand.children.forEach(function(c) {
                if (c.name.startsWith('finger_')) {
                    if (move === 'rock') {
                        // Камень: Все сжимается в кулак!
                        gsap.to(c.rotation, { x: 1.4, duration: 0.2 });
                        if (c.name === 'finger_thumb') {
                            gsap.to(c.rotation, { z: 1.4, duration: 0.2 });
                        }
                    } else if (move === 'scissors') {
                        // Ножницы: Вытянуты только указательный (0) и средний (1), раздвинуты «V»!
                        if (c.name === 'finger_0') {
                            gsap.to(c.rotation, { x: 0, z: -0.2, duration: 0.2 });
                        } else if (c.name === 'finger_1') {
                            gsap.to(c.rotation, { x: 0, z: 0.2, duration: 0.2 });
                        } else {
                            // Остальные согнуты
                            gsap.to(c.rotation, { x: 1.4, duration: 0.2 });
                        }
                        if (c.name === 'finger_thumb') {
                            gsap.to(c.rotation, { z: 1.4, duration: 0.2 });
                        }
                    } else if (move === 'paper' || move === 'none') {
                        // Бумага: Все пальцы идеально раскрыты и растопырены
                        if (c.name === 'finger_0') gsap.to(c.rotation, { x: 0, z: -0.15, duration: 0.2 });
                        else if (c.name === 'finger_1') gsap.to(c.rotation, { x: 0, z: -0.05, duration: 0.2 });
                        else if (c.name === 'finger_2') gsap.to(c.rotation, { x: 0, z: 0.05, duration: 0.2 });
                        else if (c.name === 'finger_3') gsap.to(c.rotation, { x: 0, z: 0.15, duration: 0.2 });
                        else if (c.name === 'finger_thumb') gsap.to(c.rotation, { z: 0.4, duration: 0.2 });
                    }
                }
            });
        }


        // --- АВТО-ВХОД И ЛОКАЛЬНОЕ ХРАНЕНИЕ ---
        
        window.addEventListener('DOMContentLoaded', () => {
            const savedName = localStorage.getItem('brawl_knuckles_name');
            if (savedName) {
                // Если имя сохранено, сразу входим без экрана ввода
                myUsername = savedName;
                socket.emit('join', savedName);
            }
        });

        document.getElementById('login-btn').addEventListener('click', () => {
            const nickname = document.getElementById('username-input').value.trim();
            if(nickname) {
                myUsername = nickname;
                localStorage.setItem('brawl_knuckles_name', nickname); // Сохраняем имя
                playSound('click');
                socket.emit('join', nickname);
            }
        });

        socket.on('auth_success', (data) => {
            myElo = data.elo;
            document.getElementById('user-elo').textContent = myElo;
            
            document.getElementById('auth-screen').classList.remove('active-screen');
            document.getElementById('menu-screen').classList.add('active-screen');
            
            init3DMenu();
            startBackgroundMusic();
        });


        // --- ЧАТ И КНОПКА ЗАКРЫТЬ (✖) ---

        // Открыть чат
        document.getElementById('chat-toggle-btn').addEventListener('click', () => {
            document.getElementById('chat-panel').classList.add('open');
            playSound('click');
        });

        // Закрыть чат (Устранение бага с перекрытием экрана!)
        document.getElementById('chat-close-btn').addEventListener('click', () => {
            document.getElementById('chat-panel').classList.remove('open');
            playSound('click');
        });

        document.getElementById('send-chat-btn').addEventListener('click', sendChatMessage);
        document.getElementById('chat-input').addEventListener('keypress', (e) => {
            if(e.key === 'Enter') sendChatMessage();
        });

        function sendChatMessage() {
            const val = document.getElementById('chat-input').value;
            if(val) {
                socket.emit('chat_message', val);
                document.getElementById('chat-input').value = '';
            }
        }

        socket.on('chat_broadcast', (data) => {
            const chatBox = document.getElementById('chat-messages');
            chatBox.innerHTML += `
                <div class="chat-msg"><span>\${data.username}:</span> \${data.message}</div>
            `;
            chatBox.scrollTop = chatBox.scrollHeight;
        });


        // --- ИГРОВОЙ ПРОЦЕСС ---

        socket.on('update_leaderboard', (data) => {
            document.getElementById('online-counter').textContent = "Онлайн: " + data.onlineCount;
            const container = document.getElementById('leaderboard-rows');
            container.innerHTML = '';
            data.leaderboard.forEach((player, i) => {
                container.innerHTML += `
                    <div class="leaderboard-row" style="\${player.username === myUsername ? 'color: #ffcb05;' : ''}">
                        <span>\${i+1}. \${player.username}</span>
                        <span>🏆 \${player.elo}</span>
                    </div>
                `;
            });
        });

        document.getElementById('play-trigger').addEventListener('click', () => {
            document.getElementById('mode-modal').style.display = 'flex';
            playSound('click');
        });
        document.getElementById('close-modal').addEventListener('click', () => {
            document.getElementById('mode-modal').style.display = 'none';
            playSound('click');
        });

        document.getElementById('mode-offline').addEventListener('click', () => {
            document.getElementById('mode-modal').style.display = 'none';
            playSound('click');
            startBotMatch();
        });

        document.getElementById('mode-online').addEventListener('click', () => {
            document.getElementById('mode-modal').style.display = 'none';
            playSound('click');
            isOnlineMode = true;
            botMode = false;
            socket.emit('find_match');
        });

        socket.on('searching_match', () => {
            document.getElementById('play-trigger').textContent = 'ПОИСК...';
        });

        socket.on('match_found', (data) => {
            document.getElementById('play-trigger').textContent = 'ИГРАТЬ';
            
            document.getElementById('game-p1-name').textContent = myUsername + " (🏆" + myElo + ")";
            document.getElementById('game-p2-name').textContent = data.opponent.username + " (🏆" + data.opponent.elo + ")";

            resetKOCircles();

            document.getElementById('menu-screen').classList.remove('active-screen');
            document.getElementById('game-screen').classList.add('active-screen');

            init3DGame();
            playShakeHandsAnimation();
        });

        let botScore = [0, 0];
        let botRound = 1;
        let timerInterval;

        function startBotMatch() {
            botMode = true;
            isOnlineMode = false;
            botScore = [0, 0];
            botRound = 1;

            document.getElementById('game-p1-name').textContent = myUsername + " (🏆" + myElo + ")";
            document.getElementById('game-p2-name').textContent = "Эль Примо Бот (🏆" + Math.max(0, myElo + 20) + ")";

            resetKOCircles();

            document.getElementById('menu-screen').classList.remove('active-screen');
            document.getElementById('game-screen').classList.add('active-screen');

            init3DGame();
            startBotRound();
        }

        function startBotRound() {
            document.getElementById('game-round-title').textContent = "РАУНД " + botRound;
            resetHandFingers(leftHand);
            resetHandFingers(rightHand);
            playShakeHandsAnimation();
            enableControls(true);

            let timeLeft = 10;
            const timerBar = document.getElementById('game-timer-bar');
            timerBar.style.width = '100%';
            
            if (timerInterval) clearInterval(timerInterval);
            timerInterval = setInterval(() => {
                timeLeft -= 0.1;
                timerBar.style.width = (timeLeft / 10) * 100 + "%";
                if(timeLeft <= 0) {
                    clearInterval(timerInterval);
                    processBotRound('none');
                }
            }, 100);
        }

        function processBotRound(myMove) {
            enableControls(false);
            if (timerInterval) clearInterval(timerInterval);

            const moves = ['rock', 'scissors', 'paper'];
            const botMove = moves[Math.floor(Math.random() * 3)];

            showMoves3D(myMove, botMove);

            let result = 'draw';
            if (myMove === 'none') result = 'lose';
            else if (myMove !== botMove) {
                if (
                    (myMove === 'rock' && botMove === 'scissors') ||
                    (myMove === 'scissors' && botMove === 'paper') ||
                    (myMove === 'paper' && botMove === 'rock')
                ) {
                    result = 'win';
                } else {
                    result = 'lose';
                }
            }

            if(result === 'win') {
                botScore[0]++;
                playSound('win');
            } else if(result === 'lose') {
                botScore[1]++;
                playSound('lose');
            }

            updateKOCircles(botScore[0], botScore[1]);

            setTimeout(() => {
                botRound++;
                if (botScore[0] >= 2 || botScore[1] >= 2 || botRound > 3) {
                    let matchResult = 'draw';
                    let eloChange = 0;
                    if(botScore[0] > botScore[1]) {
                        matchResult = 'win';
                        eloChange = 15;
                    } else if(botScore[1] > botScore[0]) {
                        matchResult = 'lose';
                        eloChange = -10;
                    }

                    myElo += eloChange;
                    if(myElo < 0) myElo = 0;

                    socket.emit('chat_message', "[Бот-Матч] Я сыграл в оффлайне! Мой новый рейтинг: " + myElo + " ELO"); 

                    showMatchResult(matchResult, eloChange, myElo);
                } else {
                    startBotRound();
                }
            }, 4000);
        }

        socket.on('start_round', (data) => {
            document.getElementById('game-round-title').textContent = "РАУНД " + data.roundNum;
            resetHandFingers(leftHand);
            resetHandFingers(rightHand);
            playShakeHandsAnimation();
            enableControls(true);

            let timeLeft = 10;
            const timerBar = document.getElementById('game-timer-bar');
            timerBar.style.width = '100%';

            if (timerInterval) clearInterval(timerInterval);
            timerInterval = setInterval(() => {
                timeLeft -= 0.1;
                timerBar.style.width = (timeLeft / 10) * 100 + "%";
                if(timeLeft <= 0) clearInterval(timerInterval);
            }, 100);
        });

        socket.on('round_result', (data) => {
            enableControls(false);
            if (timerInterval) clearInterval(timerInterval);

            showMoves3D(data.myMove, data.oppMove);

            if(data.result === 'win') playSound('win');
            if(data.result === 'lose') playSound('lose');

            updateKOCircles(data.score[0], data.score[1]);
        });

        socket.on('match_end', (data) => {
            showMatchResult(data.result, data.eloChange, data.newElo);
        });

        socket.on('opponent_disconnected', () => {
            alert('Противник сбежал! Автопобеда!');
            showMatchResult('win', 20, myElo + 20);
        });

        document.querySelectorAll('.control-btn').forEach(btn => {
            btn.addEventListener('click', () => {
                const move = btn.getAttribute('data-move');
                playSound('click');
                enableControls(false);
                
                if (botMode) {
                    processBotRound(move);
                } else {
                    socket.emit('make_move', move);
                }
            });
        });

        function enableControls(enable) {
            document.querySelectorAll('.control-btn').forEach(btn => {
                btn.style.pointerEvents = enable ? 'auto' : 'none';
                btn.style.opacity = enable ? '1' : '0.5';
            });
        }

        function resetKOCircles() {
            for(let i=1; i<=2; i++) {
                document.getElementById("p1-round-" + i).classList.remove('active');
                document.getElementById("p2-round-" + i).classList.remove('active');
            }
        }

        function updateKOCircles(p1Wins, p2Wins) {
            for(let i=1; i<=2; i++) {
                if(p1Wins >= i) document.getElementById("p1-round-" + i).classList.add('active');
                if(p2Wins >= i) document.getElementById("p2-round-" + i).classList.add('active');
            }
        }

        function showMatchResult(result, eloChange, newElo) {
            myElo = newElo;
            document.getElementById('user-elo').textContent = myElo;

            const overlay = document.getElementById('result-overlay');
            const resTitle = document.getElementById('result-text');
            const resDetail = document.getElementById('result-elo-detail');

            resTitle.className = "result-title " + result;
            if(result === 'win') {
                resTitle.textContent = 'ПОБЕДА!';
                resDetail.textContent = "+" + eloChange + " 🏆 кубков!";
                playSound('win');
            } else if(result === 'lose') {
                resTitle.textContent = 'ПОРАЖЕНИЕ!';
                resDetail.textContent = eloChange + " 🏆 кубков!";
                playSound('lose');
            } else {
                resTitle.textContent = 'НИЧЬЯ!';
                resDetail.textContent = '+0 🏆 кубков!';
            }

            overlay.style.display = 'flex';
            gsap.to(resTitle, { scale: 1, opacity: 1, duration: 0.5, ease: 'back.out(1.7)' });
        }

        document.getElementById('result-continue-btn').addEventListener('click', () => {
            playSound('click');
            document.getElementById('result-overlay').style.display = 'none';
            document.getElementById('game-screen').classList.remove('active-screen');
            document.getElementById('menu-screen').classList.add('add-screen');
            location.reload(); // Перезапустит страницу, авто-вход сработает моментально!
        });

        window.addEventListener('resize', () => {
            if(renderer && camera) {
                const container = document.getElementById('canvas-3d-container');
                camera.aspect = container.clientWidth / container.clientHeight;
                camera.updateProjectionMatrix();
                renderer.setSize(container.clientWidth, container.clientHeight);
            }
            if(menuRenderer && menuCamera) {
                const container = document.getElementById('menu-3d-bg');
                menuCamera.aspect = container.clientWidth / container.clientHeight;
                menuCamera.updateProjectionMatrix();
                menuRenderer.setSize(container.clientWidth, container.clientHeight);
            }
        });
    </script>
</body>
</html>
`;
}
