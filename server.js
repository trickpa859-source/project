const express = require('express');
const http = require('http');
const { Server } = require('socket.io');
const crypto = require('crypto');
const fs = require('fs');
const path = require('path');

const app = express();
const server = http.createServer(app);
const io = new Server(server);

app.use(express.static(path.join(__dirname, 'public')));

const WALLETS_FILE = path.join(__dirname, 'wallets.json');
let wallets = {};
if (fs.existsSync(WALLETS_FILE)) {
    try { wallets = JSON.parse(fs.readFileSync(WALLETS_FILE, 'utf8')); } catch (e) { wallets = {}; }
}
function saveWallets() { fs.writeFileSync(WALLETS_FILE, JSON.stringify(wallets, null, 2)); }
function getBalance(nick) {
    if (wallets[nick] === undefined) { wallets[nick] = 5000; saveWallets(); }
    return wallets[nick];
}
function modifyBalance(nick, amount) {
    wallets[nick] = getBalance(nick) + amount;
    saveWallets();
    return wallets[nick];
}

// Endpointy dla Render.com + Cron-job.org
app.get('/ping', (req, res) => res.status(200).send('OK'));
app.get('/wallets-backup', (req, res) => res.json(wallets));

function createShuffledDeck() {
    const suits = ['♠', '♥', '♦', '♣'];
    const values = ['2', '3', '4', '5', '6', '7', '8', '9', '10', 'J', 'Q', 'K', 'A'];
    const deck = [];
    for (const s of suits) for (const v of values) deck.push({ suit: s, value: v });
    for (let i = deck.length - 1; i > 0; i--) {
        const j = crypto.randomInt(0, i + 1);
        [deck[i], deck[j]] = [deck[j], deck[i]];
    }
    return deck;
}

function calcBlackjackScore(hand) {
    let score = 0, aces = 0;
    for (const c of hand) {
        if (['J', 'Q', 'K'].includes(c.value)) score += 10;
        else if (c.value === 'A') { score += 11; aces++; }
        else score += parseInt(c.value, 10);
    }
    while (score > 21 && aces > 0) { score -= 10; aces--; }
    return score;
}

function evaluateHoldemHand(sevenCards) {
    const rankMap = {'2':2,'3':3,'4':4,'5':5,'6':6,'7':7,'8':8,'9':9,'10':10,'J':11,'Q':12,'K':13,'A':14};
    const vals = sevenCards.map(c => rankMap[c.value]).sort((a,b) => b - a);
    const counts = {}, suits = {};
    sevenCards.forEach(c => {
        const r = rankMap[c.value];
        counts[r] = (counts[r] || 0) + 1;
        suits[c.suit] = suits[c.suit] || [];
        suits[c.suit].push(r);
    });
    const groups = Object.entries(counts).map(([val, cnt]) => ({ val: parseInt(val,10), cnt })).sort((a,b) => b.cnt - a.cnt || b.val - a.val);
    let flushVals = null;
    for (const s in suits) if (suits[s].length >= 5) flushVals = suits[s].sort((a,b) => b - a);

    function getStraightHigh(arr) {
        const uniq = [...new Set(arr)];
        if (uniq.includes(14)) uniq.push(1);
        let streak = 1;
        for (let i = 0; i < uniq.length - 1; i++) {
            if (uniq[i] - 1 === uniq[i+1]) { if (++streak >= 5) return uniq[i - 3]; }
            else streak = 1;
        }
        return 0;
    }
    const sfHigh = flushVals ? getStraightHigh(flushVals) : 0;
    if (sfHigh === 14) return { rank: 9, tie: 14, name: 'Poker Królewski' };
    if (sfHigh > 0) return { rank: 8, tie: sfHigh, name: 'Poker (Straight Flush)' };
    if (groups[0].cnt === 4) return { rank: 7, tie: groups[0].val * 100 + (groups[1]?.val || 0), name: 'Kareta' };
    if (groups[0].cnt === 3 && groups[1] && groups[1].cnt >= 2) return { rank: 6, tie: groups[0].val * 100 + groups[1].val, name: 'Ful (Full House)' };
    if (flushVals) return { rank: 5, tie: flushVals[0], name: 'Kolor (Flush)' };
    const stHigh = getStraightHigh(vals);
    if (stHigh > 0) return { rank: 4, tie: stHigh, name: 'Strit (Straight)' };
    if (groups[0].cnt === 3) return { rank: 3, tie: groups[0].val, name: 'Trójka' };
    if (groups[0].cnt === 2 && groups[1]?.cnt === 2) return { rank: 2, tie: groups[0].val * 100 + groups[1].val, name: 'Dwie Pary' };
    if (groups[0].cnt === 2) return { rank: 1, tie: groups[0].val, name: 'Para' };
    return { rank: 0, tie: vals[0], name: 'Wysoka Karta' };
}

const onlinePlayers = {};
const pokerTable = { active: false, stage: 0, pot: 0, deck: [], community: [], seats: {} };

function broadcastLeaderboard() {
    const list = Object.values(onlinePlayers).map(p => ({ nick: p.nick, balance: getBalance(p.nick) })).sort((a, b) => b.balance - a.balance);
    io.emit('players:update', list);
}

function broadcastPokerTable(revealAll = false) {
    const publicSeats = Object.values(pokerTable.seats).map(s => ({
        nick: s.nick, folded: s.folded, bet: s.bet,
        handName: revealAll ? s.handName : '',
        cards: revealAll && !s.folded ? s.cards : (s.cards.length ? ['hidden', 'hidden'] : [])
    }));
    io.emit('poker:state', { active: pokerTable.active, stage: pokerTable.stage, pot: pokerTable.pot, community: pokerTable.community, seats: publicSeats });
}

io.on('connection', (socket) => {
    socket.on('player:login', (rawNick) => {
        const nick = (rawNick || '').trim().slice(0, 16) || ('Gracz_' + crypto.randomInt(100, 999));
        onlinePlayers[socket.id] = { nick, bjSession: null };
        socket.emit('player:synced', { nick, balance: getBalance(nick) });
        io.emit('chat:event', { msg: `👋 ${nick} wszedł do kasyna!`, style: 'sys' });
        broadcastLeaderboard();
        broadcastPokerTable(pokerTable.stage === 5);
    });

    socket.on('player:rebuy', () => {
        const p = onlinePlayers[socket.id];
        if (!p) return;
        if (getBalance(p.nick) >= 1000) return socket.emit('app:alert', 'Darmowy Rebuy (+1000 🪙) jest dostępny poniżej 1000 żetonów!');
        const newBal = modifyBalance(p.nick, 1000);
        socket.emit('player:synced', { nick: p.nick, balance: newBal });
        io.emit('chat:event', { msg: `🪙 ${p.nick} pobrał darmowy Rebuy (+1000 🪙).`, style: 'sys' });
        broadcastLeaderboard();
    });

    socket.on('chat:send', (text) => {
        const p = onlinePlayers[socket.id];
        if (p && text) io.emit('chat:event', { msg: `${p.nick}: ${text.slice(0, 140)}`, style: '' });
    });

    // BLACKJACK
    socket.on('bj:deal', (betAmount) => {
        const p = onlinePlayers[socket.id];
        const bet = parseInt(betAmount, 10);
        if (!p || isNaN(bet) || bet < 10 || bet > getBalance(p.nick)) return;
        socket.emit('player:synced', { nick: p.nick, balance: modifyBalance(p.nick, -bet) });
        broadcastLeaderboard();
        const deck = createShuffledDeck();
        const playerHand = [deck.pop(), deck.pop()], dealerHand = [deck.pop(), deck.pop()];
        p.bjSession = { deck, playerHand, dealerHand, bet, active: true };
        if (calcBlackjackScore(playerHand) === 21) finishBlackjack(socket, p);
        else socket.emit('bj:update', { active: true, playerHand, playerScore: calcBlackjackScore(playerHand), dealerHand: [dealerHand[0], { hidden: true }], dealerScore: calcBlackjackScore([dealerHand[0]]) + ' + ?', msg: 'Twój ruch: Dobierz, Pas lub Podwój.' });
    });

    socket.on('bj:hit', () => {
        const p = onlinePlayers[socket.id];
        if (!p?.bjSession?.active) return;
        const s = p.bjSession;
        s.playerHand.push(s.deck.pop());
        if (calcBlackjackScore(s.playerHand) >= 21) finishBlackjack(socket, p);
        else socket.emit('bj:update', { active: true, playerHand: s.playerHand, playerScore: calcBlackjackScore(s.playerHand), dealerHand: [s.dealerHand[0], { hidden: true }], dealerScore: calcBlackjackScore([s.dealerHand[0]]) + ' + ?', msg: 'Dobrano kartę. Twój ruch!' });
    });

    socket.on('bj:double', () => {
        const p = onlinePlayers[socket.id];
        if (!p?.bjSession?.active) return;
        const s = p.bjSession;
        if (s.playerHand.length !== 2 || getBalance(p.nick) < s.bet) return;
        socket.emit('player:synced', { nick: p.nick, balance: modifyBalance(p.nick, -s.bet) });
        s.bet *= 2;
        s.playerHand.push(s.deck.pop());
        finishBlackjack(socket, p);
    });

    socket.on('bj:stand', () => {
        const p = onlinePlayers[socket.id];
        if (p?.bjSession?.active) finishBlackjack(socket, p);
    });

    function finishBlackjack(sock, p) {
        const s = p.bjSession;
        s.active = false;
        const pScore = calcBlackjackScore(s.playerHand);
        if (pScore <= 21) while (calcBlackjackScore(s.dealerHand) < 17) s.dealerHand.push(s.deck.pop());
        const dScore = calcBlackjackScore(s.dealerHand);
        const isNat = (pScore === 21 && s.playerHand.length === 2);
        let msg = '';
        if (pScore > 21) msg = `❌ Fura (${pScore})! Przegrywasz ${s.bet} 🪙.`;
        else if (isNat && !(dScore === 21 && s.dealerHand.length === 2)) {
            const win = Math.floor(s.bet * 2.5);
            modifyBalance(p.nick, win);
            msg = `🔥 BLACKJACK! Wygrywasz ${win} 🪙 (3:2)!`;
            io.emit('chat:event', { msg: `🃏 ${p.nick} trafił BLACKJACKA i wygrał ${win} 🪙!`, style: 'win' });
        } else if (dScore > 21 || pScore > dScore) {
            const win = s.bet * 2;
            modifyBalance(p.nick, win);
            msg = `✅ Wygrana (${pScore} vs ${dScore})! +${win} 🪙!`;
            if (win >= 400) io.emit('chat:event', { msg: `🃏 ${p.nick} wygrał ${win} 🪙 w Blackjacku!`, style: 'win' });
        } else if (pScore === dScore) {
            modifyBalance(p.nick, s.bet);
            msg = `🤝 Remis (${pScore}). Zwrot ${s.bet} 🪙.`;
        } else msg = `❌ Krupier wygrywa (${dScore} vs ${pScore}).`;

        sock.emit('player:synced', { nick: p.nick, balance: getBalance(p.nick) });
        sock.emit('bj:update', { active: false, playerHand: s.playerHand, playerScore: pScore, dealerHand: s.dealerHand, dealerScore: dScore, msg });
        broadcastLeaderboard();
    }

    // RULETKA
    const redNumbers = [1,3,5,7,9,12,14,16,18,19,21,23,25,27,30,32,34,36];
    socket.on('rl:spin', ({ bet, type, exactNum }) => {
        const p = onlinePlayers[socket.id];
        const betVal = parseInt(bet, 10);
        if (!p || isNaN(betVal) || betVal < 10 || betVal > getBalance(p.nick)) return;
        modifyBalance(p.nick, -betVal);
        const result = crypto.randomInt(0, 37);
        const isRed = redNumbers.includes(result);
        const colorName = result === 0 ? 'Zielone' : (isRed ? 'Czerwone' : 'Czarne');
        let mult = 0;
        if (type === 'red' && isRed) mult = 2;
        else if (type === 'black' && result !== 0 && !isRed) mult = 2;
        else if (type === 'zero' && result === 0) mult = 36;
        else if (type === 'even' && result !== 0 && result % 2 === 0) mult = 2;
        else if (type === 'odd' && result % 2 === 1) mult = 2;
        else if (type === 'low' && result >= 1 && result <= 18) mult = 2;
        else if (type === 'high' && result >= 19 && result <= 36) mult = 2;
        else if (type === 'number' && result === parseInt(exactNum, 10)) mult = 36;

        const win = betVal * mult;
        if (win > 0) modifyBalance(p.nick, win);
        socket.emit('player:synced', { nick: p.nick, balance: getBalance(p.nick) });
        socket.emit('rl:result', { result, colorName, isRed, win });
        if (win > 0) io.emit('chat:event', { msg: `🎡 ${p.nick} trafił ${result} (${colorName}) na Ruletce i wygrał ${win} 🪙!`, style: 'win' });
        broadcastLeaderboard();
    });

    // POKER HOLD'EM
    socket.on('poker:join', (anteAmount) => {
        const p = onlinePlayers[socket.id];
        const ante = parseInt(anteAmount, 10) || 100;
        if (!p || pokerTable.active || pokerTable.seats[socket.id] || getBalance(p.nick) < ante) return;
        modifyBalance(p.nick, -ante);
        pokerTable.pot += ante;
        pokerTable.seats[socket.id] = { nick: p.nick, cards: [], folded: false, bet: ante, handName: '' };
        socket.emit('player:synced', { nick: p.nick, balance: getBalance(p.nick) });
        io.emit('chat:event', { msg: `♠️ ${p.nick} dołączył do stołu Pokerowego (${ante} 🪙).`, style: 'sys' });
        broadcastLeaderboard();
        broadcastPokerTable(false);
    });

    socket.on('poker:start', () => {
        const seatIds = Object.keys(pokerTable.seats);
        if (pokerTable.active || seatIds.length === 0) return;
        if (seatIds.length === 1) {
            const hBet = pokerTable.seats[seatIds[0]].bet;
            pokerTable.pot += hBet;
            pokerTable.seats['BOT_DEALER'] = { nick: '🤖 Krupier Kasyna', cards: [], folded: false, bet: hBet, handName: '' };
        }
        pokerTable.active = true;
        pokerTable.stage = 1;
        pokerTable.deck = createShuffledDeck();
        pokerTable.community = [];
        for (const id of Object.keys(pokerTable.seats)) {
            pokerTable.seats[id].cards = [pokerTable.deck.pop(), pokerTable.deck.pop()];
            if (id !== 'BOT_DEALER') io.to(id).emit('poker:privateCards', pokerTable.seats[id].cards);
        }
        broadcastPokerTable(false);
    });

    socket.on('poker:raise', (amount) => {
        const p = onlinePlayers[socket.id], seat = pokerTable.seats[socket.id];
        const raiseVal = parseInt(amount, 10) || 100;
        if (!p || !pokerTable.active || !seat || seat.folded || getBalance(p.nick) < raiseVal) return;
        modifyBalance(p.nick, -raiseVal);
        seat.bet += raiseVal;
        pokerTable.pot += raiseVal;
        if (pokerTable.seats['BOT_DEALER']) { pokerTable.seats['BOT_DEALER'].bet += raiseVal; pokerTable.pot += raiseVal; }
        socket.emit('player:synced', { nick: p.nick, balance: getBalance(p.nick) });
        io.emit('chat:event', { msg: `♠️ ${p.nick} podbija pulę o ${raiseVal} 🪙!`, style: 'sys' });
        broadcastLeaderboard();
        broadcastPokerTable(false);
    });

    socket.on('poker:nextStage', () => {
        if (!pokerTable.active) return;
        pokerTable.stage++;
        if (pokerTable.stage === 2) { pokerTable.community.push(pokerTable.deck.pop(), pokerTable.deck.pop(), pokerTable.deck.pop()); broadcastPokerTable(false); }
        else if (pokerTable.stage === 3 || pokerTable.stage === 4) { pokerTable.community.push(pokerTable.deck.pop()); broadcastPokerTable(false); }
        else finishPokerShowdown();
    });

    socket.on('poker:fold', () => {
        const seat = pokerTable.seats[socket.id];
        if (!pokerTable.active || !seat || seat.folded) return;
        seat.folded = true;
        if (Object.values(pokerTable.seats).filter(s => !s.folded).length <= 1) finishPokerShowdown();
        else broadcastPokerTable(false);
    });

    function finishPokerShowdown() {
        pokerTable.stage = 5;
        pokerTable.active = false;
        while (pokerTable.community.length < 5) pokerTable.community.push(pokerTable.deck.pop());
        let bestRank = -1, bestTie = -1, winners = [];
        for (const [id, seat] of Object.entries(pokerTable.seats)) {
            if (seat.folded) continue;
            const ev = evaluateHoldemHand([...seat.cards, ...pokerTable.community]);
            seat.handName = ev.name;
            if (ev.rank > bestRank || (ev.rank === bestRank && ev.tie > bestTie)) { bestRank = ev.rank; bestTie = ev.tie; winners = [{ id, seat }]; }
            else if (ev.rank === bestRank && ev.tie === bestTie) winners.push({ id, seat });
        }
        if (winners.length > 0) {
            const prize = Math.floor(pokerTable.pot / winners.length);
            winners.forEach(w => {
                if (w.id !== 'BOT_DEALER') {
                    modifyBalance(w.seat.nick, prize);
                    io.to(w.id).emit('player:synced', { nick: w.seat.nick, balance: getBalance(w.seat.nick) });
                }
            });
            io.emit('chat:event', { msg: `🏆 Poker Showdown! Pula ${pokerTable.pot} 🪙 trafia do: ${winners.map(w => `${w.seat.nick} (${w.seat.handName})`).join(', ')}!`, style: 'win' });
        }
        broadcastLeaderboard();
        broadcastPokerTable(true);
        pokerTable.seats = {};
        pokerTable.pot = 0;
    }

    // AUTOMATY
    const slotSymbols = ['🍒', '🍒', '🍒', '🍀', '🍀', '🔔', '🔔', '7️⃣', '💎'];
    socket.on('slots:spin', (betAmount) => {
        const p = onlinePlayers[socket.id];
        const bet = parseInt(betAmount, 10);
        if (!p || isNaN(bet) || bet < 10 || bet > getBalance(p.nick)) return;
        modifyBalance(p.nick, -bet);
        const s1 = slotSymbols[crypto.randomInt(0, slotSymbols.length)];
        const s2 = slotSymbols[crypto.randomInt(0, slotSymbols.length)];
        const s3 = slotSymbols[crypto.randomInt(0, slotSymbols.length)];
        let mult = 0;
        if (s1 === '💎' && s2 === '💎' && s3 === '💎') mult = 50;
        else if (s1 === '7️⃣' && s2 === '7️⃣' && s3 === '7️⃣') mult = 25;
        else if (s1 === '🔔' && s2 === '🔔' && s3 === '🔔') mult = 12;
        else if (s1 === '🍀' && s2 === '🍀' && s3 === '🍀') mult = 8;
        else if (s1 === '🍒' && s2 === '🍒' && s3 === '🍒') mult = 5;
        else if ([s1, s2, s3].filter(s => s === '🍒' || s === '💎').length >= 2) mult = 2;

        const win = bet * mult;
        if (win > 0) modifyBalance(p.nick, win);
        socket.emit('player:synced', { nick: p.nick, balance: getBalance(p.nick) });
        socket.emit('slots:result', { reels: [s1, s2, s3], win, mult });
        if (mult >= 8) io.emit('chat:event', { msg: `🎰 ${p.nick} trafił ${s1}${s2}${s3} na Automatach i wygrał ${win} 🪙!`, style: 'win' });
        broadcastLeaderboard();
    });

    socket.on('disconnect', () => {
        if (onlinePlayers[socket.id]) {
            delete onlinePlayers[socket.id];
            delete pokerTable.seats[socket.id];
            broadcastLeaderboard();
        }
    });
});

const PORT = process.env.PORT || 3000;
server.listen(PORT, () => console.log(`🎰 Serwer działa na porcie ${PORT}`));
