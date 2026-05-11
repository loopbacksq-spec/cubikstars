const express = require('express');
const http = require('http');
const { Server } = require('socket.io');
const path = require('path');

const app = express();
const server = http.createServer(app);
const io = new Server(server);

const PORT = process.env.PORT || 3000;

// Хранилище подключенных игроков на сервере
const players = {};

// Серверная часть: раздача HTML-страницы клиенту
app.get('/', (req, res) => {
    res.send(`
<!DOCTYPE html>
<html lang="ru">
<head>
    <meta charset="UTF-8">
    <meta name="viewport" content="width=device-width, initial-scale=1.0, maximum-scale=1.0, user-scalable=no, viewport-fit=cover">
    <title>Zombie Night Escape 3D</title>
    <style>
        html, body {
            margin: 0;
            padding: 0;
            overflow: hidden;
            width: 100%;
            height: 100%;
            user-select: none;
            -webkit-user-select: none;
            font-family: 'Segoe UI', Tahoma, Geneva, Verdana, sans-serif;
            background-color: #000;
        }
        #canvas-container {
            width: 100%;
            height: 100%;
            position: absolute;
            top: 0;
            left: 0;
            z-index: 1;
        }
        /* Главное меню / Регистрация */
        #auth-screen {
            position: absolute;
            top: 0;
            left: 0;
            width: 100%;
            height: 100%;
            background: linear-gradient(135deg, #111 0%, #2c0505 100%);
            z-index: 10;
            display: flex;
            flex-direction: column;
            justify-content: center;
            align-items: center;
            color: white;
            text-align: center;
        }
        .auth-container {
            background: rgba(0, 0, 0, 0.75);
            padding: 40px;
            border-radius: 15px;
            border: 2px solid #ff3333;
            box-shadow: 0 0 25px rgba(255, 51, 51, 0.3);
            max-width: 400px;
            width: 85%;
        }
        h1 {
            color: #ff3333;
            margin-bottom: 5px;
            text-transform: uppercase;
            letter-spacing: 2px;
            font-size: 2.2rem;
            text-shadow: 0 0 10px rgba(255, 51, 51, 0.6);
        }
        p.subtitle {
            color: #aaa;
            margin-bottom: 25px;
            font-size: 0.95rem;
        }
        input {
            width: 100%;
            padding: 12px 20px;
            margin: 10px 0;
            box-sizing: border-box;
            border: 2px solid #555;
            background: #222;
            color: #fff;
            border-radius: 25px;
            font-size: 1.1rem;
            outline: none;
            text-align: center;
            transition: 0.3s;
        }
        input:focus {
            border-color: #ff3333;
            box-shadow: 0 0 10px rgba(255, 51, 51, 0.5);
        }
        button {
            width: 100%;
            background: #ff3333;
            color: white;
            border: none;
            padding: 14px;
            font-size: 1.2rem;
            font-weight: bold;
            border-radius: 25px;
            cursor: pointer;
            margin-top: 15px;
            text-transform: uppercase;
            transition: 0.2s;
        }
        button:hover {
            background: #ff5555;
            transform: scale(1.03);
        }
        /* Интерфейс во время игры */
        #hud {
            position: absolute;
            top: 20px;
            left: 20px;
            z-index: 5;
            color: white;
            font-weight: bold;
            text-shadow: 2px 2px 4px rgba(0,0,0,0.8);
            pointer-events: none;
        }
        #players-online {
            background: rgba(0, 0, 0, 0.5);
            padding: 8px 15px;
            border-radius: 10px;
            font-size: 0.9rem;
            margin-bottom: 10px;
        }
        #time-status {
            background: rgba(0, 0, 0, 0.5);
            padding: 8px 15px;
            border-radius: 10px;
            font-size: 1.1rem;
            border-left: 4px solid #ffaa00;
        }
        /* Экран Смерти */
        #death-screen {
            position: absolute;
            top: 0;
            left: 0;
            width: 100%;
            height: 100%;
            background: rgba(139, 0, 0, 0.85);
            z-index: 8;
            display: none;
            flex-direction: column;
            justify-content: center;
            align-items: center;
            color: white;
        }
        /* Виртуальный джойстик для мобилок */
        #joystick-container {
            position: absolute;
            bottom: 40px;
            left: 40px;
            width: 120px;
            height: 120px;
            background: rgba(255, 255, 255, 0.15);
            border: 2px solid rgba(255, 255, 255, 0.4);
            border-radius: 50%;
            z-index: 6;
            display: none;
            touch-action: none;
        }
        #joystick-knob {
            position: absolute;
            top: 35px;
            left: 35px;
            width: 50px;
            height: 50px;
            background: rgba(255, 255, 255, 0.7);
            border-radius: 50%;
            box-shadow: 0 4px 10px rgba(0,0,0,0.5);
        }
        /* Совет по ориентации */
        #orientation-warning {
            position: absolute;
            top: 10px;
            right: 10px;
            background: rgba(0,0,0,0.7);
            color: #ffcc00;
            padding: 8px 12px;
            border-radius: 5px;
            font-size: 0.8rem;
            z-index: 6;
            pointer-events: none;
        }
    </style>
    <script src="https://cdnjs.cloudflare.com/ajax/libs/three.js/r128/three.min.js"></script>
    <script src="/socket.io/socket.io.js"></script>
</head>
<body>

    <div id="auth-screen">
        <div class="auth-container">
            <h1>Z-ESCAPE ONLINE</h1>
            <p class="subtitle">GTA V Style Zombie Survival</p>
            <input type="text" id="nickname-input" placeholder="Введите ваш ник" maxlength="15" autofocus>
            <button id="btn-play">ИГРАТЬ</button>
        </div>
    </div>

    <div id="death-screen">
        <h1 style="font-size: 4rem; text-shadow: 0 0 20px black; margin: 0;">ВАС СЪЕЛИ!</h1>
        <p style="font-size: 1.5rem; margin: 15px 0 30px;">Зомби победили в этот раз...</p>
        <button id="btn-respawn" style="width: auto; padding: 15px 40px;">Возродиться (Новый день)</button>
    </div>

    <div id="hud">
        <div id="players-online">Игроков онлайн: <span id="online-count">1</span></div>
        <div id="time-status">Время суток: <span id="time-val">День</span> (<span id="timer-val">30</span>с)</div>
    </div>

    <div id="orientation-warning">📱 Рекомендуется играть горизонтально</div>
    
    <div id="joystick-container">
        <div id="joystick-knob"></div>
    </div>

    <div id="canvas-container"></div>

    <script>
        const socket = io();

        // Переменные состояния
        let myId = null;
        let myNickname = "Вы";
        let isDead = false;
        let onlinePlayersCount = 1;

        // UI Элементы
        const authScreen = document.getElementById('auth-screen');
        const deathScreen = document.getElementById('death-screen');
        const nicknameInput = document.getElementById('nickname-input');
        const btnPlay = document.getElementById('btn-play');
        const btnRespawn = document.getElementById('btn-respawn');
        const onlineCountText = document.getElementById('online-count');
        const timeValText = document.getElementById('time-val');
        const timerValText = document.getElementById('timer-val');
        const joystickContainer = document.getElementById('joystick-container');
        const joystickKnob = document.getElementById('joystick-knob');

        // Мобильное устройство?
        const isMobile = /Android|webOS|iPhone|iPad|iPod|BlackBerry|IEMobile|Opera Mini/i.test(navigator.userAgent);
        if (isMobile) {
            joystickContainer.style.display = 'block';
        }

        // Настройки цикла Дня/Ночи (у каждого свое)
        let isNight = false;
        let timeRemaining = 30; // 30 секунд день, 30 секунд ночь
        let cycleTimer = null;

        // Инициализация Three.js
        let scene, camera, renderer;
        let otherPlayers = {}; // Модели других игроков { id: group }
        let playerGroup; // Группа нашего персонажа
        let collisionWalls = []; // Массив стен для коллизий

        // Городские границы (Карта не бесконечная!)
        const MAP_LIMIT = 100; // Квадрат от -100 до 100

        // Зомби
        let zombies = [];
        const MAX_ZOMBIES = 15;
        let zombieSpawnTimer = null;

        // Силы и скорость
        let playerSpeed = 0.2;
        let zombieSpeed = 0.12;

        // Управление клавиатурой (Поддержка WASD и ЦФЫВ)
        const keys = {
            forward: false,
            backward: false,
            left: false,
            right: false
        };

        // Логика захвата мыши (Pointer Lock для ПК)
        let isPointerLocked = false;
        const container = document.getElementById('canvas-container');

        if (!isMobile) {
            container.addEventListener('click', () => {
                if (!isDead && authScreen.style.display === 'none') {
                    container.requestPointerLock();
                }
            });
            document.addEventListener('pointerlockchange', () => {
                isPointerLocked = document.pointerLockElement === container;
            });
        }

        // Обработка ввода мыши/поворота камеры на ПК
        let cameraPitch = -0.3; // Угол вверх/вниз
        let cameraYaw = 0;      // Угол влево/вправо
        const minPitch = -0.8;
        const maxPitch = 0.2;

        document.addEventListener('mousemove', (e) => {
            if (isPointerLocked && !isDead) {
                cameraYaw -= e.movementX * 0.0025;
                cameraPitch -= e.movementY * 0.0025;
                cameraPitch = Math.max(minPitch, Math.min(maxPitch, cameraPitch));
            }
        });

        // Мобильный тач-джойстик (Высокая плавность, без багов)
        let joystickActive = false;
        let joystickStart = { x: 0, y: 0 };
        let joystickVector = { x: 0, y: 0 };

        if (isMobile) {
            // Для тач-поворота камеры справа
            let touchStartPoint = { x: 0, y: 0 };
            document.addEventListener('touchstart', (e) => {
                for (let i = 0; i < e.touches.length; i++) {
                    let t = e.touches[i];
                    // Если тач в левой половине экрана - это джойстик
                    if (t.clientX < window.innerWidth / 2) {
                        joystickActive = true;
                        joystickStart = { x: t.clientX, y: t.clientY };
                        joystickContainer.style.left = (t.clientX - 60) + 'px';
                        joystickContainer.style.bottom = (window.innerHeight - t.clientY - 60) + 'px';
                        joystickContainer.style.top = 'auto';
                    } else {
                        // Правая половина - вращение камеры
                        touchStartPoint = { x: t.clientX, y: t.clientY };
                    }
                }
            }, { passive: true });

            document.addEventListener('touchmove', (e) => {
                for (let i = 0; i < e.touches.length; i++) {
                    let t = e.touches[i];
                    if (joystickActive && t.clientX < window.innerWidth / 2) {
                        let dx = t.clientX - joystickStart.x;
                        let dy = t.clientY - joystickStart.y;
                        let dist = Math.sqrt(dx*dx + dy*dy);
                        let maxDist = 45;

                        if (dist > maxDist) {
                            dx = (dx / dist) * maxDist;
                            dy = (dy / dist) * maxDist;
                        }
                        joystickKnob.style.transform = \`translate(\${dx}px, \${dy}px)\`;
                        // Нормализуем вектор
                        joystickVector.x = dx / maxDist;
                        joystickVector.y = dy / maxDist;
                    } else if (t.clientX >= window.innerWidth / 2) {
                        // Вращение камеры на мобилке (С исправленной осью)
                        let dx = t.clientX - touchStartPoint.x;
                        let dy = t.clientY - touchStartPoint.y;
                        touchStartPoint = { x: t.clientX, y: t.clientY };
                        
                        cameraYaw -= dx * 0.007;
                        cameraPitch -= dy * 0.007;
                        cameraPitch = Math.max(minPitch, Math.min(maxPitch, cameraPitch));
                    }
                }
            }, { passive: true });

            document.addEventListener('touchend', (e) => {
                if (e.touches.length === 0) {
                    joystickActive = false;
                    joystickVector = { x: 0, y: 0 };
                    joystickKnob.style.transform = 'translate(0px, 0px)';
                    // Возвращаем дефолтную позицию джойстика
                    joystickContainer.style.left = '40px';
                    joystickContainer.style.bottom = '40px';
                }
            });
        }

        // Старт игры по кнопке "Играть"
        btnPlay.addEventListener('click', () => {
            const nick = nicknameInput.value.trim();
            if (nick) {
                myNickname = nick;
                authScreen.style.display = 'none';
                initGame();
            }
        });

        btnRespawn.addEventListener('click', () => {
            respawnPlayer();
        });

        // Клавиатура (ПК) + русская раскладка
        const keyMap = {
            'KeyW': 'forward', 'KeyS': 'backward', 'KeyA': 'left', 'KeyD': 'right',
            'ArrowUp': 'forward', 'ArrowDown': 'backward', 'ArrowLeft': 'left', 'ArrowRight': 'right',
            'KeyЦ': 'forward', 'KeyЫ': 'backward', 'KeyФ': 'left', 'KeyВ': 'right' // русская раскладка
        };

        window.addEventListener('keydown', (e) => {
            const action = keyMap[e.code];
            if (action) keys[action] = true;
        });

        window.addEventListener('keyup', (e) => {
            const action = keyMap[e.code];
            if (action) keys[action] = false;
        });

        // 3D Моделирование (Милые кубические персонажи в стиле GTA-Roblox)
        function createPlayerModel(isMe, nickname) {
            const group = new THREE.Group();

            // Ноги
            const legGeo = new THREE.BoxGeometry(0.3, 0.6, 0.3);
            const pantsMat = new THREE.MeshLambertMaterial({ color: isMe ? 0x0055ff : 0xaa22bb });
            const leftLeg = new THREE.Mesh(legGeo, pantsMat);
            leftLeg.position.set(-0.2, 0.3, 0);
            const rightLeg = leftLeg.clone();
            rightLeg.position.x = 0.2;
            group.add(leftLeg, rightLeg);

            // Тело
            const torsoGeo = new THREE.BoxGeometry(0.8, 1.0, 0.4);
            const torsoMat = new THREE.MeshLambertMaterial({ color: isMe ? 0x33aa33 : 0xffa500 });
            const torso = new THREE.Mesh(torsoGeo, torsoMat);
            torso.position.y = 1.1;
            group.add(torso);

            // Голова
            const headGeo = new THREE.BoxGeometry(0.6, 0.6, 0.6);
            const skinMat = new THREE.MeshLambertMaterial({ color: 0xffdbac });
            const head = new THREE.Mesh(headGeo, skinMat);
            head.position.y = 1.9;
            group.add(head);

            // Милые глазки
            const eyeGeo = new THREE.BoxGeometry(0.1, 0.1, 0.05);
            const eyeMat = new THREE.MeshBasicMaterial({ color: 0x000000 });
            const leftEye = new THREE.Mesh(eyeGeo, eyeMat);
            leftEye.position.set(-0.15, 2.0, 0.31);
            const rightEye = leftEye.clone();
            rightEye.position.x = 0.15;
            group.add(leftEye, rightEye);

            // Милый ротик
            const mouthGeo = new THREE.BoxGeometry(0.15, 0.05, 0.05);
            const mouthMat = new THREE.MeshBasicMaterial({ color: 0xff5555 });
            const mouth = new THREE.Mesh(mouthGeo, mouthMat);
            mouth.position.set(0, 1.8, 0.31);
            group.add(mouth);

            // Никнейм над головой (Canvas Texture)
            const canvas = document.createElement('canvas');
            canvas.width = 256;
            canvas.height = 64;
            const ctx = canvas.getContext('2d');
            ctx.fillStyle = 'rgba(0,0,0,0.5)';
            ctx.fillRect(0, 0, 256, 64);
            ctx.font = 'bold 24px Arial';
            ctx.fillStyle = 'white';
            ctx.textAlign = 'center';
            ctx.fillText(nickname, 128, 40);
            
            const txtTex = new THREE.CanvasTexture(canvas);
            const spriteMat = new THREE.SpriteMaterial({ map: txtTex, transparent: true });
            const sprite = new THREE.Sprite(spriteMat);
            sprite.position.y = 2.6;
            sprite.scale.set(2, 0.5, 1);
            group.add(sprite);

            return group;
        }

        // Создаем страшного зомби с вытянутыми руками
        function createZombieModel() {
            const group = new THREE.Group();
            const skinMat = new THREE.MeshLambertMaterial({ color: 0x4a7c59 }); // зелёная кожа

            // Ноги
            const legGeo = new THREE.BoxGeometry(0.3, 0.6, 0.3);
            const pantsMat = new THREE.MeshLambertMaterial({ color: 0x333333 });
            const leftLeg = new THREE.Mesh(legGeo, pantsMat);
            leftLeg.position.set(-0.2, 0.3, 0);
            const rightLeg = leftLeg.clone();
            rightLeg.position.x = 0.2;
            group.add(leftLeg, rightLeg);

            // Тело (порванное)
            const torsoGeo = new THREE.BoxGeometry(0.8, 1.0, 0.4);
            const torsoMat = new THREE.MeshLambertMaterial({ color: 0x5a3e2b });
            const torso = new THREE.Mesh(torsoGeo, torsoMat);
            torso.position.y = 1.1;
            group.add(torso);

            // Голова
            const headGeo = new THREE.BoxGeometry(0.6, 0.6, 0.6);
            const head = new THREE.Mesh(headGeo, skinMat);
            head.position.y = 1.9;
            group.add(head);

            // Красные злые глаза
            const eyeGeo = new THREE.BoxGeometry(0.1, 0.1, 0.05);
            const eyeMat = new THREE.MeshBasicMaterial({ color: 0xff0000 });
            const leftEye = new THREE.Mesh(eyeGeo, eyeMat);
            leftEye.position.set(-0.15, 2.0, 0.31);
            const rightEye = leftEye.clone();
            rightEye.position.x = 0.15;
            group.add(leftEye, rightEye);

            // Руки вперед (классический зомби)
            const armGeo = new THREE.BoxGeometry(0.2, 0.2, 0.8);
            const leftArm = new THREE.Mesh(armGeo, skinMat);
            leftArm.position.set(-0.5, 1.3, 0.3);
            const rightArm = leftArm.clone();
            rightArm.position.x = 0.5;
            group.add(leftArm, rightArm);

            return group;
        }

        // Генерация ультра-красивого города в стиле GTA 5
        function buildBeautifulCity() {
            // Дорожная сеть
            const roadMaterial = new THREE.MeshLambertMaterial({ color: 0x222222 });
            const lineMaterial = new THREE.MeshBasicMaterial({ color: 0xffd700 });

            // Перекрестки и дороги сеточкой
            for (let i = -MAP_LIMIT; i <= MAP_LIMIT; i += 40) {
                // Дороги вдоль X
                const roadX = new THREE.Mesh(new THREE.PlaneGeometry(MAP_LIMIT * 2, 8), roadMaterial);
                roadX.rotation.x = -Math.PI / 2;
                roadX.position.set(0, 0.01, i);
                scene.add(roadX);

                // Дороги вдоль Z
                const roadZ = new THREE.Mesh(new THREE.PlaneGeometry(8, MAP_LIMIT * 2), roadMaterial);
                roadZ.rotation.x = -Math.PI / 2;
                roadZ.position.set(i, 0.01, 0);
                scene.add(roadZ);
            }

            // Дома и здания в кварталах
            const buildingMaterials = [
                new THREE.MeshLambertMaterial({ color: 0x3a4f7c }),
                new THREE.MeshLambertMaterial({ color: 0x5a5d64 }),
                new THREE.MeshLambertMaterial({ color: 0x7e6b5c }),
                new THREE.MeshLambertMaterial({ color: 0x4a5a4a })
            ];

            // Размещаем здания в кварталах (между дорогами)
            const blockPositions = [-60, -20, 20, 60];
            blockPositions.forEach(bx => {
                blockPositions.forEach(bz => {
                    // Создаем комплекс красивых небоскребов и жилых домов в каждом секторе
                    for (let xOff = -12; xOff <= 12; xOff += 12) {
                        for (let zOff = -12; zOff <= 12; zOff += 12) {
                            if (Math.random() > 0.3) {
                                const h = 10 + Math.random() * 35; // разные высоты зданий
                                const w = 6 + Math.random() * 4;
                                const d = 6 + Math.random() * 4;

                                const geo = new THREE.BoxGeometry(w, h, d);
                                const mat = buildingMaterials[Math.floor(Math.random() * buildingMaterials.length)];
                                const mesh = new THREE.Mesh(geo, mat);
                                mesh.position.set(bx + xOff, h / 2, bz + zOff);
                                scene.add(mesh);

                                // Добавляем коллизию, чтобы зомби и мы не ходили сквозь стены
                                collisionWalls.push({
                                    x: mesh.position.x,
                                    z: mesh.position.z,
                                    r: Math.max(w, d) / 1.7
                                });

                                // Окна на зданиях для реализма города (просто светящиеся кубики)
                                if (Math.random() > 0.5) {
                                    const windowGeo = new THREE.BoxGeometry(0.5, 0.5, 0.1);
                                    const windowMat = new THREE.MeshBasicMaterial({ color: 0xfffae6 });
                                    for (let wh = 3; wh < h - 2; wh += 4) {
                                        const wMesh = new THREE.Mesh(windowGeo, windowMat);
                                        wMesh.position.set(bx + xOff, wh, bz + zOff + d/2 + 0.05);
                                        scene.add(wMesh);
                                    }
                                }
                            }
                        }
                    }
                });
            });

            // Забор по краям города (Граница)
            const wallMat = new THREE.MeshLambertMaterial({ color: 0x8b0000 });
            const borderWallLeft = new THREE.Mesh(new THREE.BoxGeometry(5, 20, MAP_LIMIT * 2), wallMat);
            borderWallLeft.position.set(-MAP_LIMIT, 10, 0);
            scene.add(borderWallLeft);
            collisionWalls.push({ x: -MAP_LIMIT, z: 0, r: MAP_LIMIT * 2, isBorder: 'left' });

            const borderWallRight = borderWallLeft.clone();
            borderWallRight.position.x = MAP_LIMIT;
            scene.add(borderWallRight);
            collisionWalls.push({ x: MAP_LIMIT, z: 0, r: MAP_LIMIT * 2, isBorder: 'right' });

            const borderWallTop = new THREE.Mesh(new THREE.BoxGeometry(MAP_LIMIT * 2, 20, 5), wallMat);
            borderWallTop.position.set(0, 10, -MAP_LIMIT);
            scene.add(borderWallTop);
            collisionWalls.push({ x: 0, z: -MAP_LIMIT, r: MAP_LIMIT * 2, isBorder: 'top' });

            const borderWallBottom = borderWallTop.clone();
            borderWallBottom.position.z = MAP_LIMIT;
            scene.add(borderWallBottom);
            collisionWalls.push({ x: 0, z: MAP_LIMIT, r: MAP_LIMIT * 2, isBorder: 'bottom' });
        }

        // Логика инициализации игры
        function initGame() {
            scene = new THREE.Scene();
            scene.background = new THREE.Color(0xb0e0e6); // Светлое дневное небо при старте
            scene.fog = new THREE.FogExp2(0xb0e0e6, 0.015);

            camera = new THREE.PerspectiveCamera(65, window.innerWidth / window.innerHeight, 0.1, 1000);

            renderer = new THREE.WebGLRenderer({ antialias: true });
            renderer.setSize(window.innerWidth, window.innerHeight);
            renderer.shadowMap.enabled = true;
            document.getElementById('canvas-container').appendChild(renderer.domElement);

            // Свет (Солнце)
            const ambientLight = new THREE.AmbientLight(0xffffff, 0.6);
            scene.add(ambientLight);

            const dirLight = new THREE.DirectionalLight(0xffffff, 0.8);
            dirLight.position.set(50, 100, 50);
            scene.add(dirLight);

            // Трава/Земля
            const groundGeo = new THREE.PlaneGeometry(MAP_LIMIT * 2, MAP_LIMIT * 2);
            const groundMat = new THREE.MeshLambertMaterial({ color: 0x3b5f3b });
            const ground = new THREE.Mesh(groundGeo, groundMat);
            ground.rotation.x = -Math.PI / 2;
            scene.add(ground);

            // Наш персонаж
            playerGroup = createPlayerModel(true, myNickname);
            playerGroup.position.set(0, 0, 0);
            scene.add(playerGroup);

            // Построить город
            buildBeautifulCity();

            // Подключение к Socket.io
            socket.emit('join-game', {
                nickname: myNickname,
                x: playerGroup.position.x,
                z: playerGroup.position.z,
                rotY: playerGroup.rotation.y
            });

            // Слушатели сокетов
            socket.on('init', (data) => {
                myId = data.id;
                updateOnlineCount(Object.keys(data.players).length);
                // Спавним уже существующих игроков у себя на экране
                for (let id in data.players) {
                    if (id !== myId) {
                        spawnOtherPlayer(id, data.players[id]);
                    }
                }
            });

            socket.on('player-joined', (data) => {
                spawnOtherPlayer(data.id, data);
            });

            socket.on('player-moved', (data) => {
                if (otherPlayers[data.id]) {
                    otherPlayers[data.id].position.set(data.x, 0, data.z);
                    otherPlayers[data.id].rotation.y = data.rotY;
                }
            });

            socket.on('player-left', (id) => {
                if (otherPlayers[id]) {
                    scene.remove(otherPlayers[id]);
                    delete otherPlayers[id];
                }
                updateOnlineCount(Object.keys(otherPlayers).length + 1);
            });

            // Начать таймер выживания дня и ночи
            startDayNightCycle();

            // Главный цикл рендеринга
            animate();

            // Адаптация под изменение размера экрана телефона/ПК
            window.addEventListener('resize', onWindowResize);
        }

        function spawnOtherPlayer(id, data) {
            const model = createPlayerModel(false, data.nickname);
            model.position.set(data.x, 0, data.z);
            model.rotation.y = data.rotY;
            scene.add(model);
            otherPlayers[id] = model;
            updateOnlineCount(Object.keys(otherPlayers).length + 1);
        }

        function updateOnlineCount(count) {
            onlinePlayersCount = count;
            onlineCountText.textContent = count;
        }

        // Индивидуальный цикл дня и ночи
        function startDayNightCycle() {
            isNight = false;
            timeRemaining = 30; // 30 секунд день
            timeValText.textContent = "День";
            timeValText.style.color = "#ffaa00";
            document.getElementById('time-status').style.borderColor = "#ffaa00";

            if (cycleTimer) clearInterval(cycleTimer);

            cycleTimer = setInterval(() => {
                timeRemaining--;
                timerValText.textContent = timeRemaining;

                if (timeRemaining <= 0) {
                    isNight = !isNight;
                    timeRemaining = 30; // Перезапуск цикла

                    if (isNight) {
                        timeValText.textContent = "Ночь";
                        timeValText.style.color = "#ff3333";
                        document.getElementById('time-status').style.borderColor = "#ff3333";
                        // Плавный переход в ночь
                        scene.background.setHex(0x050510);
                        scene.fog.color.setHex(0x050510);
                        scene.fog.density = 0.04;
                        // Начинаем спавнить зомби
                        startZombieSpawner();
                    } else {
                        timeValText.textContent = "День";
                        timeValText.style.color = "#ffaa00";
                        document.getElementById('time-status').style.borderColor = "#ffaa00";
                        scene.background.setHex(0xb0e0e6);
                        scene.fog.color.setHex(0xb0e0e6);
                        scene.fog.density = 0.015;
                        // Днем все зомби пропадают
                        clearAllZombies();
                    }
                }
            }, 1000);
        }

        // Спавнер зомби во время Ночи
        function startZombieSpawner() {
            if (zombieSpawnTimer) clearInterval(zombieSpawnTimer);

            zombieSpawnTimer = setInterval(() => {
                if (isNight && zombies.length < MAX_ZOMBIES && !isDead) {
                    // Спавним зомби на безопасном расстоянии от игрока, но недалеко
                    const angle = Math.random() * Math.PI * 2;
                    const dist = 30 + Math.random() * 20;
                    const zx = playerGroup.position.x + Math.cos(angle) * dist;
                    const zz = playerGroup.position.z + Math.sin(angle) * dist;

                    // Убеждаемся, что не вышли за границы карты
                    if (Math.abs(zx) < MAP_LIMIT && Math.abs(zz) < MAP_LIMIT) {
                        const zModel = createZombieModel();
                        zModel.position.set(zx, 0, zz);
                        scene.add(zModel);
                        zombies.push(zModel);
                    }
                }
            }, 2000); // Спавн каждые 2 секунды по очереди до лимита
        }

        function clearAllZombies() {
            if (zombieSpawnTimer) clearInterval(zombieSpawnTimer);
            zombies.forEach(z => scene.remove(z));
            zombies = [];
        }

        // Коллизия со стенами города и границами
        function checkCollisionAndFix(pos, radius) {
            // Границы мира
            if (pos.x < -MAP_LIMIT + 2) pos.x = -MAP_LIMIT + 2;
            if (pos.x > MAP_LIMIT - 2) pos.x = MAP_LIMIT - 2;
            if (pos.z < -MAP_LIMIT + 2) pos.z = -MAP_LIMIT + 2;
            if (pos.z > MAP_LIMIT - 2) pos.z = MAP_LIMIT - 2;

            // Столкновения со зданиями
            for (let wall of collisionWalls) {
                if (wall.isBorder) continue;
                let dx = pos.x - wall.x;
                let dz = pos.z - wall.z;
                let dist = Math.sqrt(dx*dx + dz*dz);
                let minDist = radius + wall.r;

                if (dist < minDist) {
                    // Выталкиваем объект из стены здания
                    let overlap = minDist - dist;
                    pos.x += (dx / dist) * overlap;
                    pos.z += (dz / dist) * overlap;
                }
            }
        }

        // Поиск пути/Обход препятствий для Зомби
        function updateZombieAI() {
            if (isDead) return;

            zombies.forEach(z => {
                let dx = playerGroup.position.x - z.position.x;
                let dz = playerGroup.position.z - z.position.z;
                let distToPlayer = Math.sqrt(dx*dx + dz*dz);

                // Радиус обнаружения нас зомби
                const detectionRadius = 35;

                if (distToPlayer < detectionRadius) {
                    // Зомби нас заметил и бежит
                    let dirX = dx / distToPlayer;
                    let dirZ = dz / distToPlayer;

                    // Движение вперед с обходом коллизий
                    let nextX = z.position.x + dirX * zombieSpeed;
                    let nextZ = z.position.z + dirZ * zombieSpeed;

                    let potentialPos = new THREE.Vector3(nextX, 0, nextZ);
                    
                    // Умный обход: если перед зомби стена, смещаем его вбок
                    for (let wall of collisionWalls) {
                        if (wall.isBorder) continue;
                        let wdx = potentialPos.x - wall.x;
                        let wdz = potentialPos.z - wall.z;
                        let wdist = Math.sqrt(wdx*wdx + wdz*wdz);
                        if (wdist < (0.5 + wall.r)) {
                            // Идем в обход стены перпендикулярно вектору к игроку
                            potentialPos.x += -dirZ * zombieSpeed * 1.5;
                            potentialPos.z += dirX * zombieSpeed * 1.5;
                        }
                    }

                    z.position.copy(potentialPos);
                    z.lookAt(playerGroup.position.x, 0, playerGroup.position.z);

                    // Зомби догнал нас! Кусает / Съедает
                    if (distToPlayer < 1.2) {
                        playerGetEaten();
                    }
                } else {
                    // Если далеко, зомби просто бродит без цели
                    if (Math.random() < 0.02) {
                        z.userData.wanderAngle = Math.random() * Math.PI * 2;
                    }
                    if (z.userData.wanderAngle !== undefined) {
                        z.position.x += Math.cos(z.userData.wanderAngle) * (zombieSpeed * 0.4);
                        z.position.z += Math.sin(z.userData.wanderAngle) * (zombieSpeed * 0.4);
                        checkCollisionAndFix(z.position, 0.5);
                        z.rotation.y = -z.userData.wanderAngle;
                    }
                }
            });
        }

        // Анимация «Поедания» и Смерть
        function playerGetEaten() {
            isDead = true;
            clearAllZombies();
            if (cycleTimer) clearInterval(cycleTimer);

            // Анимация падения камеры и персонажа
            let duration = 20;
            let count = 0;
            function fall() {
                if (count < duration) {
                    playerGroup.rotation.z += Math.PI / 40;
                    playerGroup.position.y -= 0.05;
                    camera.position.y -= 0.1;
                    count++;
                    requestAnimationFrame(fall);
                } else {
                    // Показать экран смерти
                    if (isPointerLocked) document.exitPointerLock();
                    deathScreen.style.display = 'flex';
                }
            }
            fall();
        }

        // Возрождение на новой карте (всегда начинается днем)
        function respawnPlayer() {
            isDead = false;
            deathScreen.style.display = 'none';

            // Новый случайный спавн на карте подальше от стен
            const rx = (Math.random() - 0.5) * (MAP_LIMIT - 30);
            const rz = (Math.random() - 0.5) * (MAP_LIMIT - 30);
            playerGroup.position.set(rx, 0, rz);
            playerGroup.rotation.set(0, 0, 0);

            // Сброс цикла на День
            startDayNightCycle();
        }

        // Изменение ориентации / ресайз
        function onWindowResize() {
            camera.aspect = window.innerWidth / window.innerHeight;
            camera.updateProjectionMatrix();
            renderer.setSize(window.innerWidth, window.innerHeight);
        }

        // Главный цикл обновлений и рендеринга (60 FPS)
        function animate() {
            requestAnimationFrame(animate);

            if (!isDead && playerGroup) {
                // Вычисление направления движения на основе направления взгляда камеры (Ось исправлена!)
                let moveX = 0;
                let moveZ = 0;

                if (isMobile && joystickActive) {
                    // Джойстик подстраивается под прицел камеры
                    let forwardX = Math.sin(cameraYaw);
                    let forwardZ = Math.cos(cameraYaw);
                    let rightX = Math.cos(cameraYaw);
                    let rightZ = -Math.sin(cameraYaw);

                    moveX = (forwardX * -joystickVector.y + rightX * joystickVector.x) * playerSpeed;
                    moveZ = (forwardZ * -joystickVector.y + rightZ * joystickVector.x) * playerSpeed;
                } else {
                    // ПК WASD клавиатура подстраивается под мышь
                    let forwardX = Math.sin(cameraYaw);
                    let forwardZ = Math.cos(cameraYaw);
                    let rightX = Math.cos(cameraYaw);
                    let rightZ = -Math.sin(cameraYaw);

                    if (keys.forward) {
                        moveX -= forwardX * playerSpeed;
                        moveZ -= forwardZ * playerSpeed;
                    }
                    if (keys.backward) {
                        moveX += forwardX * playerSpeed;
                        moveZ += forwardZ * playerSpeed;
                    }
                    if (keys.left) {
                        moveX -= rightX * playerSpeed;
                        moveZ -= rightZ * playerSpeed;
                    }
                    if (keys.right) {
                        moveX += rightX * playerSpeed;
                        moveZ += rightZ * playerSpeed;
                    }
                }

                // Применяем перемещение персонажа
                playerGroup.position.x += moveX;
                playerGroup.position.z += moveZ;

                // Столкновения с границами и зданиями
                checkCollisionAndFix(playerGroup.position, 0.6);

                // Игрок разворачивается в сторону движения
                if (moveX !== 0 || moveZ !== 0) {
                    playerGroup.rotation.y = Math.atan2(-moveX, -moveZ);
                }

                // Отправляем новые координаты серверу для мультиплеера
                socket.emit('move', {
                    x: playerGroup.position.x,
                    z: playerGroup.position.z,
                    rotY: playerGroup.rotation.y
                });

                // Камера от 3-го лица за спиной игрока в стиле GTA 5
                const cameraDist = 6;
                camera.position.x = playerGroup.position.x + Math.sin(cameraYaw) * cameraDist * Math.cos(cameraPitch);
                camera.position.z = playerGroup.position.z + Math.cos(cameraYaw) * cameraDist * Math.cos(cameraPitch);
                camera.position.y = playerGroup.position.y + 2.0 - Math.sin(cameraPitch) * cameraDist;

                camera.lookAt(playerGroup.position.x, playerGroup.position.y + 1.2, playerGroup.position.z);
            }

            // Обновление искусственного интеллекта зомби
            if (isNight) {
                updateZombieAI();
            }

            renderer.render(scene, camera);
        }

    </script>
</body>
</html>
    `);
});

// Серверная обработка Socket.io
io.on('connection', (socket) => {
    console.log('Новый пользователь подключился: ' + socket.id);

    socket.on('join-game', (data) => {
        players[socket.id] = {
            id: socket.id,
            nickname: data.nickname,
            x: data.x,
            z: data.z,
            rotY: data.rotY
        };

        // Отправляем игроку ID и список остальных игроков
        socket.emit('init', {
            id: socket.id,
            players: players
        });

        // Оповещаем остальных игроков о подключении нового
        socket.broadcast.emit('player-joined', players[socket.id]);
    });

    // Получаем перемещение игрока и передаем остальным
    socket.on('move', (data) => {
        if (players[socket.id]) {
            players[socket.id].x = data.x;
            players[socket.id].z = data.z;
            players[socket.id].rotY = data.rotY;

            socket.broadcast.emit('player-moved', {
                id: socket.id,
                x: data.x,
                z: data.z,
                rotY: data.rotY
            });
        }
    });

    // Отключение игрока
    socket.on('disconnect', () => {
        console.log('Пользователь отключился: ' + socket.id);
        delete players[socket.id];
        io.emit('player-left', socket.id);
    });
});

server.listen(PORT, () => {
    console.log(`Сервер запущен на порту http://localhost:${PORT}`);
});
