const http = require('http');
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

const PORT = 3000;
const USERS_FILE = path.join(__dirname, 'users.json');
const MESSAGES_FILE = path.join(__dirname, 'messages.json');
// Аватар (base64 dataURL) до 10 МБ раздувается примерно в ~1.37 раза в JSON,
// плюс небольшой запас на остальные поля запроса.
const MAX_BODY_SIZE = 14 * 1024 * 1024;
const CHAT_HISTORY_LIMIT = 200;
const CHAT_MESSAGE_MAX_LEN = 2000;

console.log('Путь к файлу users.json:', USERS_FILE);

/* ---------- Работа с файлом ---------- */

function readUsers() {
    try {
        if (!fs.existsSync(USERS_FILE)) return [];
        const raw = fs.readFileSync(USERS_FILE, 'utf8');
        return JSON.parse(raw || '[]');
    } catch (e) {
        console.error('Ошибка чтения:', e);
        return [];
    }
}

function saveUsers(users) {
    fs.writeFileSync(USERS_FILE, JSON.stringify(users, null, 2), 'utf8');
    console.log('💾 Файл users.json сохранён');
}

function readMessages() {
    try {
        if (!fs.existsSync(MESSAGES_FILE)) return [];
        const raw = fs.readFileSync(MESSAGES_FILE, 'utf8');
        return JSON.parse(raw || '[]');
    } catch (e) {
        console.error('Ошибка чтения сообщений:', e);
        return [];
    }
}

function saveMessages(messages) {
    fs.writeFileSync(MESSAGES_FILE, JSON.stringify(messages, null, 2), 'utf8');
}

/* ---------- Хеширование ---------- */

function hashPassword(password, salt) {
    return crypto.createHash('sha256').update(salt + ':' + password).digest('hex');
}

function generateSalt() {
    return crypto.randomBytes(16).toString('hex');
}

/* ---------- Ответы ---------- */

function sendJSON(res, status, data) {
    res.writeHead(status, {
        'Content-Type': 'application/json; charset=utf-8',
        'Access-Control-Allow-Origin': '*',
        'Access-Control-Allow-Headers': 'Content-Type',
        'Access-Control-Allow-Methods': 'GET, POST, OPTIONS'
    });
    res.end(JSON.stringify(data));
}

function sendFile(res, filePath, contentType) {
    fs.readFile(filePath, function (err, data) {
        if (err) {
            res.writeHead(404, { 'Content-Type': 'text/plain; charset=utf-8' });
            res.end('Файл не найден');
            return;
        }
        res.writeHead(200, { 'Content-Type': contentType });
        res.end(data);
    });
}

function readBody(req) {
    return new Promise(function (resolve, reject) {
        let body = '';
        req.on('data', function (chunk) {
            body += chunk;
            if (body.length > MAX_BODY_SIZE) {
                reject(new Error('Слишком большой запрос'));
                req.destroy();
            }
        });
        req.on('end', function () {
            try {
                resolve(body ? JSON.parse(body) : {});
            } catch (e) {
                reject(new Error('Некорректный JSON'));
            }
        });
        req.on('error', reject);
    });
}

/* ---------- API ---------- */

async function handleRegister(req, res) {
    try {
        const data = await readBody(req);
        const username = (data.username || '').trim();
        const email = (data.email || '').trim();
        const password = data.password || '';

        console.log('📥 Регистрация:', username, email);

        if (username.length < 3) {
            return sendJSON(res, 400, { error: 'Имя — минимум 3 символа' });
        }
        if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) {
            return sendJSON(res, 400, { error: 'Некорректный email' });
        }
        if (password.length < 6) {
            return sendJSON(res, 400, { error: 'Пароль — минимум 6 символов' });
        }

        const users = readUsers();
        const lowerName = username.toLowerCase();
        const lowerEmail = email.toLowerCase();

        for (let i = 0; i < users.length; i++) {
            if (users[i].username.toLowerCase() === lowerName) {
                return sendJSON(res, 409, { error: 'Такое имя уже занято' });
            }
            if (users[i].email.toLowerCase() === lowerEmail) {
                return sendJSON(res, 409, { error: 'Эта почта уже зарегистрирована' });
            }
        }

        const salt = generateSalt();
        const passwordHash = hashPassword(password, salt);

        const newUser = {
            username: username,
            email: email,
            salt: salt,
            passwordHash: passwordHash,
            avatar: '',
            createdAt: new Date().toISOString()
        };

        users.push(newUser);
        saveUsers(users);

        console.log('✅ Зарегистрирован:', username);
        sendJSON(res, 201, {
            username: newUser.username,
            email: newUser.email,
            avatar: newUser.avatar
        });
    } catch (e) {
        console.error('❌ Ошибка регистрации:', e);
        sendJSON(res, 500, { error: 'Ошибка сервера' });
    }
}

async function handleLogin(req, res) {
    try {
        const data = await readBody(req);
        const login = (data.login || '').trim().toLowerCase();
        const password = data.password || '';

        console.log('📥 Вход:', login);

        if (!login || !password) {
            return sendJSON(res, 400, { error: 'Введите логин и пароль' });
        }

        const users = readUsers();
        let user = null;

        for (let i = 0; i < users.length; i++) {
            if (users[i].username.toLowerCase() === login ||
                users[i].email.toLowerCase() === login) {
                user = users[i];
                break;
            }
        }

        if (!user) {
            return sendJSON(res, 404, { error: 'Пользователь не найден' });
        }

        const hash = hashPassword(password, user.salt);
        if (hash !== user.passwordHash) {
            return sendJSON(res, 401, { error: 'Неверный пароль' });
        }

        console.log('✅ Вошёл:', user.username);
        sendJSON(res, 200, {
            username: user.username,
            email: user.email,
            avatar: user.avatar || ''
        });
    } catch (e) {
        console.error('❌ Ошибка входа:', e);
        sendJSON(res, 500, { error: 'Ошибка сервера' });
    }
}

function handleUsersList(req, res) {
    const users = readUsers();
    const safe = users.map(function (u) {
        return { username: u.username, email: u.email, avatar: u.avatar || '', createdAt: u.createdAt };
    });
    sendJSON(res, 200, { users: safe });
}

async function handleUpdateProfile(req, res) {
    try {
        const data = await readBody(req);
        const currentUsername = (data.currentUsername || '').trim();
        const newUsername = (data.newUsername || '').trim();
        const hasAvatar = Object.prototype.hasOwnProperty.call(data, 'avatar');
        const avatar = data.avatar;

        console.log('📥 Обновление профиля:', currentUsername, '→', newUsername);

        if (!currentUsername) {
            return sendJSON(res, 400, { error: 'Не указан текущий пользователь' });
        }
        if (newUsername.length < 3 || newUsername.length > 20) {
            return sendJSON(res, 400, { error: 'Ник — от 3 до 20 символов' });
        }
        if (hasAvatar && typeof avatar === 'string' && avatar.length > MAX_BODY_SIZE) {
            return sendJSON(res, 400, { error: 'Аватар слишком большой' });
        }

        const users = readUsers();
        let user = null;
        for (let i = 0; i < users.length; i++) {
            if (users[i].username.toLowerCase() === currentUsername.toLowerCase()) {
                user = users[i];
                break;
            }
        }
        if (!user) {
            return sendJSON(res, 404, { error: 'Пользователь не найден' });
        }

        const lowerNewName = newUsername.toLowerCase();
        if (lowerNewName !== user.username.toLowerCase()) {
            for (let i = 0; i < users.length; i++) {
                if (users[i] !== user && users[i].username.toLowerCase() === lowerNewName) {
                    return sendJSON(res, 409, { error: 'Такое имя уже занято' });
                }
            }
        }

        user.username = newUsername;
        if (hasAvatar) {
            user.avatar = typeof avatar === 'string' ? avatar : '';
        }

        saveUsers(users);

        console.log('✅ Профиль обновлён:', user.username);
        sendJSON(res, 200, {
            username: user.username,
            email: user.email,
            avatar: user.avatar || ''
        });
    } catch (e) {
        console.error('❌ Ошибка обновления профиля:', e);
        sendJSON(res, 500, { error: 'Ошибка сервера' });
    }
}

/* ---------- Чат ---------- */

function handleChatGet(req, res) {
    const messages = readMessages();
    const last = messages.slice(-CHAT_HISTORY_LIMIT);
    sendJSON(res, 200, { messages: last });
}

async function handleChatPost(req, res) {
    try {
        const data = await readBody(req);
        const username = (data.username || '').trim();
        const text = (data.text || '').trim();

        if (!username) {
            return sendJSON(res, 400, { error: 'Не указан отправитель' });
        }
        if (!text) {
            return sendJSON(res, 400, { error: 'Сообщение пустое' });
        }
        if (text.length > CHAT_MESSAGE_MAX_LEN) {
            return sendJSON(res, 400, { error: 'Сообщение слишком длинное' });
        }

        const users = readUsers();
        let author = null;
        for (let i = 0; i < users.length; i++) {
            if (users[i].username.toLowerCase() === username.toLowerCase()) {
                author = users[i];
                break;
            }
        }
        if (!author) {
            return sendJSON(res, 404, { error: 'Пользователь не найден' });
        }

        const message = {
            id: Date.now().toString(36) + Math.random().toString(36).slice(2, 8),
            username: author.username,
            avatar: author.avatar || '',
            text: text,
            createdAt: new Date().toISOString()
        };

        const messages = readMessages();
        messages.push(message);
        // Храним не больше последних 1000 сообщений, чтобы файл не разрастался бесконечно.
        const trimmed = messages.length > 1000 ? messages.slice(-1000) : messages;
        saveMessages(trimmed);

        console.log('💬', author.username + ':', text);
        sendJSON(res, 201, { message: message });
    } catch (e) {
        console.error('❌ Ошибка отправки сообщения:', e);
        sendJSON(res, 500, { error: 'Ошибка сервера' });
    }
}

/* ---------- Сервер ---------- */

const server = http.createServer(function (req, res) {
    const url = req.url.split('?')[0];

    console.log('→', req.method, url);

    if (req.method === 'OPTIONS') {
        res.writeHead(204, {
            'Access-Control-Allow-Origin': '*',
            'Access-Control-Allow-Headers': 'Content-Type',
            'Access-Control-Allow-Methods': 'GET, POST, OPTIONS'
        });
        res.end();
        return;
    }

    if (url === '/api/register' && req.method === 'POST') {
        return handleRegister(req, res);
    }
    if (url === '/api/login' && req.method === 'POST') {
        return handleLogin(req, res);
    }
    if (url === '/api/users' && req.method === 'GET') {
        return handleUsersList(req, res);
    }
    if (url === '/api/update-profile' && req.method === 'POST') {
        return handleUpdateProfile(req, res);
    }
    if (url === '/api/chat/messages' && req.method === 'GET') {
        return handleChatGet(req, res);
    }
    if (url === '/api/chat/messages' && req.method === 'POST') {
        return handleChatPost(req, res);
    }

    if (url === '/' || url === '/index.html') {
        return sendFile(res, path.join(__dirname, 'index.html'), 'text/html; charset=utf-8');
    }

    // Отдаём 404 тоже в JSON, чтобы fetch(...).then(res => res.json())
    // на фронте никогда не падал с "Unexpected token" на текстовом ответе.
    sendJSON(res, 404, { error: 'Не найдено' });
});

server.listen(PORT, function () {
    console.log('');
    console.log('🔥 Сервер Hot запущен!');
    console.log('👉 Открой: http://localhost:' + PORT);
    console.log('📁 Файл users.json будет тут:', USERS_FILE);
    console.log('');
});