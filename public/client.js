const socket = io();

let authMode = 'login';
let myNick = '';
let myPrivateCards = [];
let nextRebuyTimestamp = 0;
let wheelAngle = 0;

function setAuthMode(mode) {
    authMode = mode;
    document.getElementById('tab-login').classList.toggle('active', mode === 'login');
    document.getElementById('tab-register').classList.toggle('active', mode === 'register');
    document.getElementById('auth-err').textContent = '';
}

function submitAuth() {
    const nick = document.getElementById('auth-nick').value.trim();
    const password = document.getElementById('auth-pass').value;
    const avatar = document.getElementById('auth-avatar').value;
    const flag = document.getElementById('auth-flag').value;
    socket.emit('auth:submit', { mode: authMode, nick, password, avatar, flag });
}

function logout() {
    localStorage.removeItem('royal_saved_creds');
    location.reload();
}

window.addEventListener('DOMContentLoaded', () => {
    const saved = localStorage.getItem('royal_saved_creds');
    if (saved) {
        try {
            const creds = JSON.parse(saved);
            if (creds.nick && creds.password) {
                socket.emit('auth:submit', { mode: 'login', nick: creds.nick, password: creds.password });
            }
        } catch (e) {}
    }
});

socket.on('auth:error', (msg) => {
    document.getElementById('auth-err').textContent = msg;
});

socket.on('auth:success', ({ account, savedCreds }) => {
    localStorage.setItem('royal_saved_creds', JSON.stringify(savedCreds));
    document.getElementById('auth-modal').style.display = 'none';
    syncAccountUI(account);
});

socket.on('player:synced', (acc) => {
    if (acc) syncAccountUI(acc);
});

function syncAccountUI(acc) {
    myNick = acc.nick;
    document.getElementById('ui-nick').textContent = acc.nick;
    document.getElementById('ui-avatar').textContent = acc.avatar;
    document.getElementById('ui-level').textContent = acc.level;
    document.getElementById('ui-balance').textContent = Number(acc.balance).toLocaleString();
    document.getElementById('bj-p-name').textContent = `${acc.avatar} ${acc.nick}`;
    nextRebuyTimestamp = acc.nextRebuyAt || 0;
    updateRebuyButton();
}

function updateRebuyButton() {
    const btn = document.getElementById('btn-rebuy');
    const diff = nextRebuyTimestamp - Date.now();
    if (diff <= 0) {
        btn.disabled = false;
        btn.textContent = '+ Rebuy ($5,000)';
    } else {
        btn.disabled = true;
        const totalMin = Math.ceil(diff / 60000);
        const h = Math.floor(totalMin / 60);
        const m = totalMin % 60;
        btn.textContent = `⏳ Rebuy za ${h}h ${m}m`;
    }
}
setInterval(updateRebuyButton, 15000);

function rebuy() { socket.emit('player:rebuy'); }

function switchTab(id, btn) {
    document.querySelectorAll('.game-stage').forEach(p => p.classList.remove('active'));
    document.querySelectorAll('.tab-btn').forEach(b => b.classList.remove('active'));
    document.getElementById('game-' + id).classList.add('active');
    btn.classList.add('active');
}

function renderCard(c) {
    if (!c || c === 'hidden' || c.hidden) return `<div class="card hidden"></div>`;
    const isRed = c.suit === '♥' || c.suit === '♦';
    return `<div class="card ${isRed ? 'red' : ''}">
        <div>${c.value}</div>
        <div class="card-center">${c.suit}</div>
    </div>`;
}

socket.on('players:update', (list) => {
    document.getElementById('leaderboard').innerHTML = list.map((p, i) => `
        <li class="player-item">
            <span>#${i + 1} ${p.avatar} <strong>${p.nick}</strong> ${p.flag} <small style="color:#38bdf8">[${p.level}]</small></span>
            <span style="color:var(--cyan-cash); font-weight:800;">$${Number(p.balance).toLocaleString()}</span>
        </li>
    `).join('');
});

socket.on('chat:event', ({ msg, style }) => {
    const log = document.getElementById('chat-log');
    const div = document.createElement('div');
    if (style === 'win') div.className = 'log-win';
    if (style === 'sys') div.className = 'log-sys';
    div.textContent = msg;
    log.appendChild(div);
    log.scrollTop = log.scrollHeight;
});

socket.on('app:alert', (msg) => alert(msg));

function sendChat() {
    const inp = document.getElementById('chat-in');
    if (inp.value.trim()) { socket.emit('chat:send', inp.value.trim()); inp.value = ''; }
}

function sendEmoji(emoji) { socket.emit('table:emoji', emoji); }

socket.on('table:emoji', ({ nick, emoji }) => {
    const zone = document.getElementById('emoji-fly-zone');
    const el = document.createElement('div');
    el.className = 'flying-emoji';
    el.style.left = (25 + Math.random() * 50) + '%';
    el.style.bottom = '60px';
    el.innerHTML = `${emoji}<div style="font-size:0.75rem; color:#fff; text-align:center;">${nick}</div>`;
    zone.appendChild(el);
    setTimeout(() => el.remove(), 2200);
});

function pkJoin() { myPrivateCards = []; socket.emit('poker:join', document.getElementById('pk-bet').value); }
function pkLeave() { socket.emit('poker:leave'); }
function pkStart() { socket.emit('poker:start'); }
function pkNext() { socket.emit('poker:nextStage'); }
function pkRaise() { socket.emit('poker:raise', document.getElementById('pk-bet').value); }
function pkFold() { socket.emit('poker:fold'); }

socket.on('poker:privateCards', (cards) => {
    myPrivateCards = cards;
});

socket.on('poker:state', (state) => {
    document.getElementById('pk-pot').textContent = Number(state.pot).toLocaleString();
    document.getElementById('pk-community').innerHTML = state.community.map(renderCard).join('');

    const stages = [
        'Oczekiwanie na graczy (minimum 2 graczy przy stole)...',
        'Pre-Flop — Licytacja przed kartami wspólnymi',
        'Flop — 3 karty wspólne na stole',
        'Turn — 4 karta wspólna',
        'River — 5 karta wspólna (Ostatnia licytacja!)',
        'Showdown — Porównanie układów!'
    ];
    document.getElementById('pk-status').textContent = stages[state.stage] || '';

    const amISeated = state.seats.some(s => s.nick === myNick);
    document.getElementById('pk-btn-join').disabled = state.active || amISeated;
    document.getElementById('pk-btn-leave').disabled = state.active || !amISeated;
    document.getElementById('pk-btn-start').disabled = state.active || state.seats.length < 2;
    document.getElementById('pk-btn-next').disabled = !state.active || !amISeated;
    document.getElementById('pk-btn-raise').disabled = !state.active || !amISeated;
    document.getElementById('pk-btn-fold').disabled = !state.active || !amISeated;

    let orderedSeats = [...state.seats];
    const myIdx = orderedSeats.findIndex(s => s.nick === myNick);
    if (myIdx > 0) {
        orderedSeats = [...orderedSeats.slice(myIdx), ...orderedSeats.slice(0, myIdx)];
    }

    const ring = document.getElementById('pk-seats-ring');
    ring.innerHTML = orderedSeats.map((s, idx) => {
        const isMe = s.nick === myNick;
        const cardsToRender = (isMe && myPrivateCards.length === 2 && !s.folded) ? myPrivateCards : s.cards;
        const cardsHTML = cardsToRender && cardsToRender.length
            ? `<div class="seat-hole-cards">${cardsToRender.map(renderCard).join('')}</div>`
            : '';

        return `
            <div class="poker-seat seat-pos-${idx}" style="${s.folded ? 'opacity:0.45;' : ''}">
                ${s.isWinner ? `<div class="win-glow-banner">WIN</div>` : ''}
                <div class="seat-top-row">
                    <div class="seat-avatar-wrap">
                        ${s.isDealer ? `<div class="dealer-btn-badge">D</div>` : ''}
                        <div class="seat-avatar">${s.avatar}</div>
                        <span class="seat-lvl">${s.level}</span>
                        <span class="seat-flag">${s.flag}</span>
                    </div>
                    ${cardsHTML}
                </div>
                <div class="seat-plate">
                    <div class="seat-name">${s.nick} ${s.folded ? '(Pas)' : ''}</div>
                    <div class="seat-cash">$${Number(s.balance).toLocaleString()}</div>
                    ${s.handName ? `<div style="color:#4ade80; font-size:0.75rem; font-weight:800;">${s.handName}</div>` : ''}
                </div>
                <div class="seat-bet-pill">W puli: $${Number(s.bet).toLocaleString()}</div>
            </div>
        `;
    }).join('');
});

function bjDeal() {
    document.getElementById('bj-win-badge').style.display = 'none';
    socket.emit('bj:deal', document.getElementById('bj-bet').value);
}
function bjHit() { socket.emit('bj:hit'); }
function bjStand() { socket.emit('bj:stand'); }
function bjDouble() { socket.emit('bj:double'); }

socket.on('bj:update', (d) => {
    document.getElementById('bj-pot-val').textContent = Number(d.bet || 0).toLocaleString();
    document.getElementById('bj-p-cards').innerHTML = d.playerHand.map(renderCard).join('');
    document.getElementById('bj-p-score').textContent = d.playerScore;
    document.getElementById('bj-d-cards').innerHTML = d.dealerHand.map(renderCard).join('');
    document.getElementById('bj-d-score').textContent = d.dealerScore;
    document.getElementById('bj-status').textContent = d.msg;
    document.getElementById('bj-win-badge').style.display = d.isWin ? 'block' : 'none';

    document.getElementById('bj-deal').disabled = d.active;
    document.getElementById('bj-hit').disabled = !d.active;
    document.getElementById('bj-stand').disabled = !d.active;
    document.getElementById('bj-double').disabled = !d.active || d.playerHand.length !== 2;
});

let rlType = 'red';
function selRl(type, el) {
    rlType = type;
    document.querySelectorAll('.bet-option').forEach(b => b.classList.remove('selected'));
    el.classList.add('selected');
}
function rlSpin() {
    document.getElementById('rl-win-badge').style.display = 'none';
    document.getElementById('rl-spin-btn').disabled = true;
    document.getElementById('rl-status').textContent = 'Koło ruletki się kręci...';
    socket.emit('rl:spin', {
        bet: document.getElementById('rl-bet').value,
        type: rlType,
        exactNum: document.getElementById('rl-num').value
    });
}
socket.on('rl:result', ({ result, colorName, isRed, win }) => {
    const ring = document.getElementById('rl-wheel-ring');
    const inner = document.getElementById('rl-wheel');
    wheelAngle += 1440 + Math.floor(Math.random() * 360);
    ring.style.transform = `rotate(${wheelAngle}deg)`;
    inner.style.transform = `rotate(-${wheelAngle}deg)`;

    setTimeout(() => {
        inner.textContent = result;
        inner.style.backgroundColor = result === 0 ? '#15803d' : (isRed ? '#b91c1c' : '#1e293b');
        document.getElementById('rl-win-badge').style.display = win > 0 ? 'block' : 'none';
        document.getElementById('rl-status').textContent = win > 0
            ? `🎉 Wypadło ${result} (${colorName})! Wygrywasz $${win.toLocaleString()}!`
            : `Wypadło ${result} (${colorName}). Spróbuj ponownie!`;
        document.getElementById('rl-spin-btn').disabled = false;
    }, 2200);
});

function slSpin() {
    document.getElementById('sl-win-badge').style.display = 'none';
    document.getElementById('sl-spin-btn').disabled = true;
    ['sl-1', 'sl-2', 'sl-3'].forEach(id => document.getElementById(id).classList.add('spinning'));
    socket.emit('slots:spin', document.getElementById('sl-bet').value);
}
socket.on('slots:result', ({ reels, win, mult }) => {
    const ids = ['sl-1', 'sl-2', 'sl-3'];
    ids.forEach((id, idx) => {
        setTimeout(() => {
            const el = document.getElementById(id);
            el.classList.remove('spinning');
            el.textContent = reels[idx];
            if (idx === 2) {
                document.getElementById('sl-win-badge').style.display = win > 0 ? 'block' : 'none';
                document.getElementById('sl-status').textContent = win > 0
                    ? `🎰 TRAFIONO! Wygrywasz $${win.toLocaleString()} (${mult}x)!`
                    : 'Brak linii wygrywającej. Spróbuj ponownie!';
                document.getElementById('sl-spin-btn').disabled = false;
            }
        }, 450 * (idx + 1));
    });
});