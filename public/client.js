const socket = io();
let myNick = localStorage.getItem('casino_nick') || ('Gracz_' + Math.floor(100 + Math.random() * 900));
document.getElementById('nick-input').value = myNick;
socket.emit('player:login', myNick);

function changeNick() {
    const val = document.getElementById('nick-input').value.trim();
    if (val) { myNick = val; localStorage.setItem('casino_nick', myNick); socket.emit('player:login', myNick); }
}
function rebuy() { socket.emit('player:rebuy'); }
function switchTab(id, btn) {
    document.querySelectorAll('.game-panel').forEach(p => p.classList.remove('active'));
    document.querySelectorAll('.tab-btn').forEach(b => b.classList.remove('active'));
    document.getElementById('game-' + id).classList.add('active');
    btn.classList.add('active');
}
function renderCard(c) {
    if (!c || c === 'hidden' || c.hidden) return `<div class="card hidden"></div>`;
    const isRed = c.suit === '♥' || c.suit === '♦';
    return `<div class="card ${isRed ? 'red' : ''}"><div>${c.value}${c.suit}</div><div class="card-center">${c.suit}</div><div style="text-align:right;">${c.value}${c.suit}</div></div>`;
}

socket.on('player:synced', (d) => { document.getElementById('nick-input').value = d.nick; document.getElementById('ui-balance').textContent = d.balance; });
socket.on('players:update', (list) => {
    document.getElementById('leaderboard').innerHTML = list.map((p, i) => `<li class="player-item"><span>#${i + 1} <strong>${p.nick}</strong></span><span style="color:var(--green); font-weight:bold;">${p.balance} 🪙</span></li>`).join('');
});
socket.on('chat:event', ({ msg, style }) => {
    const log = document.getElementById('chat-log'), div = document.createElement('div');
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

function pkJoin() { document.getElementById('pk-my-cards').innerHTML = ''; socket.emit('poker:join', document.getElementById('pk-bet').value); }
function pkStart() { socket.emit('poker:start'); }
function pkNext() { socket.emit('poker:nextStage'); }
function pkRaise() { socket.emit('poker:raise', document.getElementById('pk-bet').value); }
function pkFold() { socket.emit('poker:fold'); }

socket.on('poker:privateCards', (cards) => { document.getElementById('pk-my-cards').innerHTML = cards.map(renderCard).join(''); });
socket.on('poker:state', (state) => {
    document.getElementById('pk-pot').textContent = state.pot;
    document.getElementById('pk-community').innerHTML = state.community.map(renderCard).join('');
    const stages = ['Oczekiwanie na graczy w puli...', 'Pre-Flop (Licytacja)', 'Flop (3 karty wspólne)', 'Turn (4 karta wspólna)', 'River (5 karta wspólna)', 'Showdown (Porównanie układów!)'];
    document.getElementById('pk-status').textContent = stages[state.stage] || '';
    document.getElementById('pk-btn-join').disabled = state.active;
    document.getElementById('pk-btn-start').disabled = state.active || state.seats.length === 0;
    document.getElementById('pk-btn-next').disabled = !state.active;
    document.getElementById('pk-btn-raise').disabled = !state.active;
    document.getElementById('pk-btn-fold').disabled = !state.active;
    document.getElementById('pk-seats-list').innerHTML = state.seats.map(s => `<div class="seat-box"><div><strong>${s.nick}</strong> ${s.folded ? '❌ (Pas)' : ''}</div><div style="font-size:0.8rem; color:var(--gold);">W puli: ${s.bet} 🪙</div>${s.handName ? `<div style="color:var(--green); font-weight:bold; font-size:0.85rem;">${s.handName}</div>` : ''}${s.cards.length && s.cards[0] !== 'hidden' ? `<div style="display:flex; gap:4px; justify-content:center; margin-top:5px; transform:scale(0.75);">${s.cards.map(renderCard).join('')}</div>` : ''}</div>`).join('');
});

function bjDeal() { socket.emit('bj:deal', document.getElementById('bj-bet').value); }
function bjHit() { socket.emit('bj:hit'); }
function bjStand() { socket.emit('bj:stand'); }
function bjDouble() { socket.emit('bj:double'); }
socket.on('bj:update', (d) => {
    document.getElementById('bj-p-cards').innerHTML = d.playerHand.map(renderCard).join('');
    document.getElementById('bj-p-score').textContent = d.playerScore;
    document.getElementById('bj-d-cards').innerHTML = d.dealerHand.map(renderCard).join('');
    document.getElementById('bj-d-score').textContent = d.dealerScore;
    document.getElementById('bj-status').textContent = d.msg;
    document.getElementById('bj-deal').disabled = d.active;
    document.getElementById('bj-hit').disabled = !d.active;
    document.getElementById('bj-stand').disabled = !d.active;
    document.getElementById('bj-double').disabled = !d.active || d.playerHand.length !== 2;
});

let rlType = 'red';
function selRl(type, el) { rlType = type; document.querySelectorAll('.bet-option').forEach(b => b.classList.remove('selected')); el.classList.add('selected'); }
function rlSpin() { socket.emit('rl:spin', { bet: document.getElementById('rl-bet').value, type: rlType, exactNum: document.getElementById('rl-num').value }); }
socket.on('rl:result', ({ result, colorName, isRed, win }) => {
    const w = document.getElementById('rl-wheel');
    w.textContent = result;
    w.style.backgroundColor = result === 0 ? '#27ae60' : (isRed ? '#c0392b' : '#1e272e');
    document.getElementById('rl-status').textContent = win > 0 ? `🎉 Wypadło ${result} (${colorName})! Wygrywasz ${win} 🪙!` : `Wypadło ${result} (${colorName}). Spróbuj ponownie!`;
});

function slSpin() { socket.emit('slots:spin', document.getElementById('sl-bet').value); }
socket.on('slots:result', ({ reels, win, mult }) => {
    document.getElementById('sl-1').textContent = reels[0];
    document.getElementById('sl-2').textContent = reels[1];
    document.getElementById('sl-3').textContent = reels[2];
    document.getElementById('sl-status').textContent = win > 0 ? `🎰 TRAFIONO! Wygrywasz ${win} 🪙 (${mult}x)!` : 'Brak linii wygrywającej. Spróbuj ponownie!';
});