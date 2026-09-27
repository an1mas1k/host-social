const http = require('http');
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

const PORT = process.env.PORT || 3000;
const USERS_FILE = '/data/users.json';
const MAX_AVATAR_SIZE = 10 * 1024 * 1024;

console.log('users.json:', USERS_FILE);

function readUsers() {
    try {
        if (!fs.existsSync(USERS_FILE)) return [];
        return JSON.parse(fs.readFileSync(USERS_FILE, 'utf8') || '[]');
    } catch (e) { return []; }
}

function saveUsers(users) {
    fs.writeFileSync(USERS_FILE, JSON.stringify(users, null, 2), 'utf8');
    console.log('💾 users.json сохранён');
}

function hashPassword(password, salt) {
    return crypto.createHash('sha256').update(salt + ':' + password).digest('hex');
}

function generateSalt() {
    return crypto.randomBytes(16).toString('hex');
}

function sendJSON(res, status, data) {
    res.writeHead(status, {
        'Content-Type': 'application/json; charset=utf-8',
        'Access-Control-Allow-Origin': '*',
        'Access-Control-Allow-Headers': 'Content-Type',
        'Access-Control-Allow-Methods': 'GET, POST, OPTIONS'
    });
    res.end(JSON.stringify(data));
}

function sendFile(res, filePath) {
    fs.readFile(filePath, function (err, data) {
        if (err) {
            res.writeHead(404, { 'Content-Type': 'text/plain; charset=utf-8' });
            res.end('Not found');
            return;
        }
        res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
        res.end(data);
    });
}

function readBody(req) {
    return new Promise(function (resolve, reject) {
        let body = '';
        req.on('data', function (chunk) {
            body += chunk;
            if (body.length > 20e6) {
                reject(new Error('Слишком большой запрос'));
                req.destroy();
            }
        });
        req.on('end', function () {
            try { resolve(body ? JSON.parse(body) : {}); }
            catch (e) { reject(new Error('Некорректный JSON')); }
        });
        req.on('error', reject);
    });
}

function publicUser(u) {
    return {
        username: u.username,
        email: u.email || '',
        avatar: u.avatar || null,
        createdAt: u.createdAt
    };
}

async function handleRegister(req, res) {
    try {
        const data = await readBody(req);
        const username = (data.username || '').trim();
        const email = (data.email || '').trim();
        const password = data.password || '';

        if (username.length < 3) return sendJSON(res, 400, { error: 'Имя — минимум 3' });
        if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) return sendJSON(res, 400, { error: 'Некорректный email' });
        if (password.length < 6) return sendJSON(res, 400, { error: 'Пароль — минимум 6' });

        const users = readUsers();
        const ln = username.toLowerCase();
        const le = email.toLowerCase();

        for (let i = 0; i < users.length; i++) {
            if (users[i].username.toLowerCase() === ln) return sendJSON(res, 409, { error: 'Имя занято' });
            if (users[i].email && users[i].email.toLowerCase() === le) return sendJSON(res, 409, { error: 'Почта занята' });
        }

        const salt = generateSalt();
        const newUser = {
            username: username,
            email: email,
            salt: salt,
            passwordHash: hashPassword(password, salt),
            avatar: null,
            createdAt: new Date().toISOString()
        };

        users.push(newUser);
        saveUsers(users);
        console.log('✅ Регистрация:', username);
        sendJSON(res, 201, publicUser(newUser));
    } catch (e) {
        console.error('❌ Регистрация:', e);
        sendJSON(res, 500, { error: 'Ошибка сервера' });
    }
}

async function handleLogin(req, res) {
    try {
        const data = await readBody(req);
        const login = (data.login || '').trim().toLowerCase();
        const password = data.password || '';

        if (!login || !password) return sendJSON(res, 400, { error: 'Введите логин и пароль' });

        const users = readUsers();
        let user = null;
        for (let i = 0; i < users.length; i++) {
            if (users[i].username.toLowerCase() === login ||
                (users[i].email && users[i].email.toLowerCase() === login)) {
                user = users[i]; break;
            }
        }
        if (!user) return sendJSON(res, 404, { error: 'Пользователь не найден' });

        if (hashPassword(password, user.salt) !== user.passwordHash) {
            return sendJSON(res, 401, { error: 'Неверный пароль' });
        }

        console.log('✅ Вход:', user.username);
        sendJSON(res, 200, publicUser(user));
    } catch (e) {
        console.error('❌ Вход:', e);
        sendJSON(res, 500, { error: 'Ошибка сервера' });
    }
}

function handleUsersList(req, res) {
    const users = readUsers();
    sendJSON(res, 200, { users: users.map(publicUser) });
}

async function handleUpdateProfile(req, res) {
    try {
        const data = await readBody(req);
        const currentUsername = (data.currentUsername || '').trim();
        const newUsername = (data.newUsername || '').trim();
        const newAvatar = data.avatar;

        console.log('📥 Обновление:', currentUsername, '→', newUsername);

        if (!currentUsername) return sendJSON(res, 400, { error: 'Не указан пользователь' });

        const users = readUsers();
        let user = null;
        for (let i = 0; i < users.length; i++) {
            if (users[i].username === currentUsername) { user = users[i]; break; }
        }
        if (!user) return sendJSON(res, 404, { error: 'Пользователь не найден' });

        if (newUsername && newUsername !== currentUsername) {
            if (newUsername.length < 3) return sendJSON(res, 400, { error: 'Ник — минимум 3' });
            if (newUsername.length > 20) return sendJSON(res, 400, { error: 'Ник — максимум 20' });

            const ln = newUsername.toLowerCase();
            for (let i = 0; i < users.length; i++) {
                if (users[i].username.toLowerCase() === ln) {
                    return sendJSON(res, 409, { error: 'Этот ник занят' });
                }
            }
            user.username = newUsername;
        }

        if (newAvatar !== undefined && newAvatar !== null) {
            if (newAvatar === '') {
                user.avatar = null;
            } else {
                if (typeof newAvatar !== 'string' || !newAvatar.startsWith('data:image/')) {
                    return sendJSON(res, 400, { error: 'Неверный формат аватара' });
                }
                if (newAvatar.length > MAX_AVATAR_SIZE * 1.4) {
                    return sendJSON(res, 400, { error: 'Аватар больше 10 МБ' });
                }
                user.avatar = newAvatar;
            }
        }

        saveUsers(users);
        console.log('✅ Профиль обновлён:', user.username);
        sendJSON(res, 200, publicUser(user));
    } catch (e) {
        console.error('❌ Профиль:', e);
        sendJSON(res, 500, { error: 'Ошибка сервера' });
    }
}

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

    if (url === '/api/register' && req.method === 'POST') return handleRegister(req, res);
    if (url === '/api/login' && req.method === 'POST') return handleLogin(req, res);
    if (url === '/api/users' && req.method === 'GET') return handleUsersList(req, res);
    if (url === '/api/update-profile' && req.method === 'POST') return handleUpdateProfile(req, res);

    if (url === '/' || url === '/index.html') {
        return sendFile(res, path.join(__dirname, 'index.html'));
    }

    res.writeHead(404, { 'Content-Type': 'text/plain; charset=utf-8' });
    res.end('Not found');
});

server.listen(PORT, '0.0.0.0', function () {
    console.log('');
    console.log('🔥 Сервер Hot запущен!');
    console.log('👉 http://localhost:' + PORT);
    console.log('');
});
