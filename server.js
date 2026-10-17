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

const ACCOUNTS_FILE = path.join(__dirname, 'accounts.json');
const REBUY_COOLDOWN_MS = 12 * 60 * 60 * 1000; // 12 godzin
const REBUY_AMOUNT = 5000;

let accounts = {};
if (fs.existsSync(ACCOUNTS_FILE)) {
    try { accounts = JSON.parse(fs.readFileSync(ACCOUNTS_FILE, 'utf8')); } catch (e) { accounts = {}; }
}
function saveAccounts() {
    fs.writeFileSync(ACCOUNTS_FILE, JSON.stringify(accounts, null, 2));
}
function hashPassword(pw) {
    return crypto.createHash('sha256').update(String(pw)).digest('hex');
}
function addXP(nick, amount = 1) {
    if (!accounts[nick]) return;
    accounts[nick].xp = (accounts[nick].xp || 0) + amount;
    accounts[nick].level = Math.floor(accounts[nick].xp / 4) + 1;
    saveAccounts();
}
function getPublicAccount(nick) {
    const a = accounts[nick];
    if (!a) return null;
    const now = Date.now();
    const nextRebuyAt = (a.lastRebuy || 0) + REBUY_COOLDOWN_MS;
    return {
        nick: a.nick,
        balance: a.balance,
        avatar: a.avatar || '😎',
        flag: a.flag || '🇵🇱',
        level: a.level || 1,
        rebuyReady: now >= nextRebuyAt,
        nextRebuyAt
    };
}

app.get('/ping', (req, res) => res.status(200).send('OK'));
app.get('/accounts-backup', (req, res) => res.json(accounts));

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
const pokerTable = {
    active: false,
    stage: 0,
    pot: 0,
    dealerIdx: 0,
    deck: [],
    community: [],
    seats: {}
};

function broadcastLeaderboard() {
    const list = Object.values(onlinePlayers)
        .map(p => getPublicAccount(p.nick))
        .filter(Boolean)
        .sort((a, b) => b.balance - a.balance);
    io.emit('players:update', list);
}

function broadcastPokerTable(revealAll = false) {
    const seatEntries = Object.entries(pokerTable.seats);
    const publicSeats = seatEntries.map(([sockId, s], idx) => {
        const acc = accounts[s.nick] || {};
        return {
            socketId: sockId,
            nick: s.nick,
            avatar: acc.avatar || '😎',
            flag: acc.flag || '🇵🇱',
            level: acc.level || 1,
            balance: acc.balance ?? 0,
            folded: s.folded,
            bet: s.bet,
            isDealer: idx === (pokerTable.dealerIdx % Math.max(1, seatEntries.length)),
            isWinner: Boolean(s.isWinner),
            handName: revealAll ? s.handName : '',
            cards: revealAll && !s.folded ? s.cards : (s.cards.length ? ['hidden', 'hidden'] : [])
        };
    });
    io.emit('poker:state', {
        active: pokerTable.active,
        stage: pokerTable.stage,
        pot: pokerTable.pot,
        community: pokerTable.community,
        seats: publicSeats
    });
}

io.on('connection', (socket) => {
    socket.on('auth:submit', ({ mode, nick, password, avatar, flag }) => {
        const cleanNick = (nick || '').trim().slice(0, 15);
        if (!cleanNick || !password || password.length < 3) {
            return socket.emit('auth:error', 'Podaj nick oraz hasło (min. 3 znaki)!');
        }
        if (mode === 'register') {
            if (accounts[cleanNick]) {
                return socket.emit('auth:error', 'Ten nick jest już zajęty! Wybierz logowanie.');
            }
            accounts[cleanNick] = {
                nick: cleanNick,
                passHash: hashPassword(password),
                avatar: avatar || '😎',
                flag: flag || '🇵🇱',
                level: 1,
                xp: 0,
                balance: 10000,
                lastRebuy: 0
            };
            saveAccounts();
        } else {
            const acc = accounts[cleanNick];
            if (!acc || acc.passHash !== hashPassword(password)) {
                return socket.emit('auth:error', 'Nieprawidłowy nick lub hasło!');
            }
            if (avatar) acc.avatar = avatar;
            if (flag) acc.flag = flag;
            saveAccounts();
        }

        onlinePlayers[socket.id] = { nick: cleanNick, bjSession: null };
        socket.emit('auth:success', {
            account: getPublicAccount(cleanNick),
            savedCreds: { nick: cleanNick, password }
        });
        io.emit('chat:event', { msg: `👋 ${cleanNick} dołączył do kasyna!`, style: 'sys' });
        broadcastLeaderboard();
        broadcastPokerTable(pokerTable.stage === 5);
    });

    socket.on('player:rebuy', () => {
        const p = onlinePlayers[socket.id];
        if (!p || !accounts[p.nick]) return;
        const acc = accounts[p.nick];
        const now = Date.now();
        const nextAllowed = (acc.lastRebuy || 0) + REBUY_COOLDOWN_MS;

        if (now < nextAllowed) {
            const diffMin = Math.ceil((nextAllowed - now) / 60000);
            const h = Math.floor(diffMin / 60);
            const m = diffMin % 60;
            return socket.emit('app:alert', `⏳ Rebuy jest dostępny raz na 12 godzin! Pozostało: ${h}h ${m}m.`);
        }

        acc.balance += REBUY_AMOUNT;
        acc.lastRebuy = now;
        saveAccounts();

        socket.emit('player:synced', getPublicAccount(p.nick));
        io.emit('chat:event', { msg: `💰 ${p.nick} odebrał darmowy Rebuy (+$${REBUY_AMOUNT.toLocaleString()})!`, style: 'sys' });
        broadcastLeaderboard();
        broadcastPokerTable(pokerTable.stage === 5);
    });

    socket.on('table:emoji', (emoji) => {
        const p = onlinePlayers[socket.id];
        if (!p) return;
        io.emit('table:emoji', { nick: p.nick, emoji: String(emoji).slice(0, 4) });
    });

    socket.on('chat:send', (text) => {
        const p = onlinePlayers[socket.id];
        if (p && text) io.emit('chat:event', { msg: `${p.nick}: ${text.slice(0, 140)}`, style: '' });
    });

    socket.on('poker:join', (anteAmount) => {
        const p = onlinePlayers[socket.id];
        if (!p || !accounts[p.nick]) return;
        const acc = accounts[p.nick];
        const ante = Math.max(10, parseInt(anteAmount, 10) || 200);

        if (pokerTable.active) return socket.emit('app:alert', 'Poczekaj na koniec bieżącego rozdania!');
        if (pokerTable.seats[socket.id]) return;
        if (Object.keys(pokerTable.seats).length >= 6) return socket.emit('app:alert', 'Stół jest pełny (maks. 6 graczy)!');
        if (acc.balance < ante) return socket.emit('app:alert', 'Brak wystarczających środków na wejście!');

        if (pokerTable.stage === 5) {
            pokerTable.seats = {};
            pokerTable.pot = 0;
            pokerTable.community = [];
            pokerTable.stage = 0;
        }

        acc.balance -= ante;
        saveAccounts();
        pokerTable.pot += ante;
        pokerTable.seats[socket.id] = {
            nick: p.nick, cards: [], folded: false, bet: ante, handName: '', isWinner: false
        };

        socket.emit('player:synced', getPublicAccount(p.nick));
        io.emit('chat:event', { msg: `♠️ ${p.nick} usiadł przy stole ($${ante}).`, style: 'sys' });
        broadcastLeaderboard();
        broadcastPokerTable(false);
    });

    socket.on('poker:leave', () => {
        const p = onlinePlayers[socket.id];
        const seat = pokerTable.seats[socket.id];
        if (!p || !seat || pokerTable.active) return;
        accounts[p.nick].balance += seat.bet;
        pokerTable.pot = Math.max(0, pokerTable.pot - seat.bet);
        delete pokerTable.seats[socket.id];
        saveAccounts();
        socket.emit('player:synced', getPublicAccount(p.nick));
        broadcastLeaderboard();
        broadcastPokerTable(false);
    });

    socket.on('poker:start', () => {
        const seatIds = Object.keys(pokerTable.seats);
        if (pokerTable.active) return;
        if (seatIds.length < 2) {
            return socket.emit('app:alert', 'Do gry w Pokera (bez krupiera) potrzebnych jest minimum 2 graczy przy stole!');
        }

        pokerTable.active = true;
        pokerTable.stage = 1;
        pokerTable.dealerIdx = (pokerTable.dealerIdx + 1) % seatIds.length;
        pokerTable.deck = createShuffledDeck();
        pokerTable.community = [];

        for (const id of seatIds) {
            pokerTable.seats[id].folded = false;
            pokerTable.seats[id].isWinner = false;
            pokerTable.seats[id].handName = '';
            pokerTable.seats[id].cards = [pokerTable.deck.pop(), pokerTable.deck.pop()];
            io.to(id).emit('poker:privateCards', pokerTable.seats[id].cards);
            addXP(pokerTable.seats[id].nick, 1);
        }
        broadcastPokerTable(false);
    });

    socket.on('poker:raise', (amount) => {
        const p = onlinePlayers[socket.id];
        const seat = pokerTable.seats[socket.id];
        const raiseVal = Math.max(10, parseInt(amount, 10) || 200);
        if (!p || !pokerTable.active || !seat || seat.folded) return;
        const acc = accounts[p.nick];
        if (acc.balance < raiseVal) return socket.emit('app:alert', 'Brak środków na takie podbicie!');

        acc.balance -= raiseVal;
        saveAccounts();
        seat.bet += raiseVal;
        pokerTable.pot += raiseVal;

        socket.emit('player:synced', getPublicAccount(p.nick));
        io.emit('chat:event', { msg: `🔥 ${p.nick} podbija pulę o $${raiseVal.toLocaleString()}!`, style: 'sys' });
        broadcastLeaderboard();
        broadcastPokerTable(false);
    });

    socket.on('poker:nextStage', () => {
        if (!pokerTable.active) return;
        pokerTable.stage++;
        if (pokerTable.stage === 2) {
            pokerTable.community.push(pokerTable.deck.pop(), pokerTable.deck.pop(), pokerTable.deck.pop());
            broadcastPokerTable(false);
        } else if (pokerTable.stage === 3 || pokerTable.stage === 4) {
            pokerTable.community.push(pokerTable.deck.pop());
            broadcastPokerTable(false);
        } else {
            finishPokerShowdown();
        }
    });

    socket.on('poker:fold', () => {
        const seat = pokerTable.seats[socket.id];
        if (!pokerTable.active || !seat || seat.folded) return;
        seat.folded = true;
        const activeSeats = Object.values(pokerTable.seats).filter(s => !s.folded);
        if (activeSeats.length <= 1) finishPokerShowdown();
        else broadcastPokerTable(false);
    });

    function finishPokerShowdown() {
        pokerTable.stage = 5;
        pokerTable.active = false;
        while (pokerTable.community.length < 5) pokerTable.community.push(pokerTable.deck.pop());

        let bestRank = -1, bestTie = -1, winners = [];
        const activeEntries = Object.entries(pokerTable.seats).filter(([_, s]) => !s.folded);

        if (activeEntries.length === 1) {
            const [winId, winSeat] = activeEntries[0];
            winSeat.handName = 'Pozostali spasowali';
            winners = [{ id: winId, seat: winSeat }];
        } else {
            for (const [id, seat] of activeEntries) {
                const ev = evaluateHoldemHand([...seat.cards, ...pokerTable.community]);
                seat.handName = ev.name;
                if (ev.rank > bestRank || (ev.rank === bestRank && ev.tie > bestTie)) {
                    bestRank = ev.rank; bestTie = ev.tie; winners = [{ id, seat }];
                } else if (ev.rank === bestRank && ev.tie === bestTie) {
                    winners.push({ id, seat });
                }
            }
        }

        if (winners.length > 0) {
            const prize = Math.floor(pokerTable.pot / winners.length);
            winners.forEach(w => {
                w.seat.isWinner = true;
                if (accounts[w.seat.nick]) {
                    accounts[w.seat.nick].balance += prize;
                    addXP(w.seat.nick, 3);
                }
                io.to(w.id).emit('player:synced', getPublicAccount(w.seat.nick));
            });
            saveAccounts();
            io.emit('chat:event', {
                msg: `🏆 WIN! Pula $${pokerTable.pot.toLocaleString()} trafia do: ${winners.map(w => `${w.seat.nick} (${w.seat.handName})`).join(', ')}!`,
                style: 'win'
            });
        }

        broadcastLeaderboard();
        broadcastPokerTable(true);
        setTimeout(() => {
            if (!pokerTable.active && pokerTable.stage === 5) {
                pokerTable.seats = {};
                pokerTable.pot = 0;
                broadcastPokerTable(false);
            }
        }, 7500);
    }

    socket.on('bj:deal', (betAmount) => {
        const p = onlinePlayers[socket.id];
        if (!p || !accounts[p.nick]) return;
        const acc = accounts[p.nick];
        const bet = parseInt(betAmount, 10);
        if (isNaN(bet) || bet < 10 || bet > acc.balance) return socket.emit('app:alert', 'Nieprawidłowa stawka!');

        acc.balance -= bet;
        addXP(p.nick, 1);
        saveAccounts();
        socket.emit('player:synced', getPublicAccount(p.nick));
        broadcastLeaderboard();

        const deck = createShuffledDeck();
        const playerHand = [deck.pop(), deck.pop()], dealerHand = [deck.pop(), deck.pop()];
        p.bjSession = { deck, playerHand, dealerHand, bet, active: true };

        if (calcBlackjackScore(playerHand) === 21) finishBlackjack(socket, p);
        else socket.emit('bj:update', {
            active: true, playerHand, playerScore: calcBlackjackScore(playerHand),
            dealerHand: [dealerHand[0], { hidden: true }],
            dealerScore: calcBlackjackScore([dealerHand[0]]),
            bet, winAmount: 0, isWin: false, msg: 'Twój ruch: Dobierz, Pas lub Podwój.'
        });
    });

    socket.on('bj:hit', () => {
        const p = onlinePlayers[socket.id];
        if (!p?.bjSession?.active) return;
        const s = p.bjSession;
        s.playerHand.push(s.deck.pop());
        if (calcBlackjackScore(s.playerHand) >= 21) finishBlackjack(socket, p);
        else socket.emit('bj:update', {
            active: true, playerHand: s.playerHand, playerScore: calcBlackjackScore(s.playerHand),
            dealerHand: [s.dealerHand[0], { hidden: true }],
            dealerScore: calcBlackjackScore([s.dealerHand[0]]),
            bet: s.bet, winAmount: 0, isWin: false, msg: 'Dobrano kartę!'
        });
    });

    socket.on('bj:double', () => {
        const p = onlinePlayers[socket.id];
        if (!p?.bjSession?.active) return;
        const s = p.bjSession;
        const acc = accounts[p.nick];
        if (s.playerHand.length !== 2 || acc.balance < s.bet) return;
        acc.balance -= s.bet;
        s.bet *= 2;
        saveAccounts();
        socket.emit('player:synced', getPublicAccount(p.nick));
        s.playerHand.push(s.deck.pop());
        finishBlackjack(socket, p);
    });

    socket.on('bj:stand', () => {
        const p = onlinePlayers[socket.id];
        if (p?.bjSession?.active) finishBlackjack(socket, p);
    });

    function finishBlackjack(sock, p) {
        const s = p.bjSession;
        const acc = accounts[p.nick];
        s.active = false;
        const pScore = calcBlackjackScore(s.playerHand);
        if (pScore <= 21) while (calcBlackjackScore(s.dealerHand) < 17) s.dealerHand.push(s.deck.pop());
        const dScore = calcBlackjackScore(s.dealerHand);
        const isNat = (pScore === 21 && s.playerHand.length === 2);
        let msg = '', winAmount = 0, isWin = false;

        if (pScore > 21) {
            msg = `Fura (${pScore})! Przegrywasz $${s.bet}.`;
        } else if (isNat && !(dScore === 21 && s.dealerHand.length === 2)) {
            winAmount = Math.floor(s.bet * 2.5);
            acc.balance += winAmount;
            isWin = true;
            msg = `BLACKJACK! +$${winAmount.toLocaleString()}!`;
            io.emit('chat:event', { msg: `🃏 ${p.nick} trafił BLACKJACKA ($${winAmount})!`, style: 'win' });
        } else if (dScore > 21 || pScore > dScore) {
            winAmount = s.bet * 2;
            acc.balance += winAmount;
            isWin = true;
            msg = `Wygrana (${pScore} vs ${dScore})! +$${winAmount.toLocaleString()}!`;
        } else if (pScore === dScore) {
            acc.balance += s.bet;
            msg = `Remis (${pScore}) — zwrot $${s.bet}.`;
        } else {
            msg = `Krupier wygrywa (${dScore} vs ${pScore}).`;
        }

        saveAccounts();
        sock.emit('player:synced', getPublicAccount(p.nick));
        sock.emit('bj:update', {
            active: false, playerHand: s.playerHand, playerScore: pScore,
            dealerHand: s.dealerHand, dealerScore: dScore,
            bet: s.bet, winAmount, isWin, msg
        });
        broadcastLeaderboard();
    }

    const redNumbers = [1,3,5,7,9,12,14,16,18,19,21,23,25,27,30,32,34,36];
    socket.on('rl:spin', ({ bet, type, exactNum }) => {
        const p = onlinePlayers[socket.id];
        if (!p || !accounts[p.nick]) return;
        const acc = accounts[p.nick];
        const betVal = parseInt(bet, 10);
        if (isNaN(betVal) || betVal < 10 || betVal > acc.balance) return socket.emit('app:alert', 'Nieprawidłowa stawka!');

        acc.balance -= betVal;
        addXP(p.nick, 1);
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
        if (win > 0) acc.balance += win;
        saveAccounts();

        socket.emit('player:synced', getPublicAccount(p.nick));
        socket.emit('rl:result', { result, colorName, isRed, win });
        if (win > 0) io.emit('chat:event', { msg: `🎡 ${p.nick} trafił ${result} (${colorName}) i wygrał $${win.toLocaleString()}!`, style: 'win' });
        broadcastLeaderboard();
    });

    const slotSymbols = ['🍒', '🍒', '🍒', '🍀', '🍀', '🔔', '🔔', '7️⃣', '💎'];
    socket.on('slots:spin', (betAmount) => {
        const p = onlinePlayers[socket.id];
        if (!p || !accounts[p.nick]) return;
        const acc = accounts[p.nick];
        const bet = parseInt(betAmount, 10);
        if (isNaN(bet) || bet < 10 || bet > acc.balance) return socket.emit('app:alert', 'Nieprawidłowa stawka!');

        acc.balance -= bet;
        addXP(p.nick, 1);
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
        if (win > 0) acc.balance += win;
        saveAccounts();

        socket.emit('player:synced', getPublicAccount(p.nick));
        socket.emit('slots:result', { reels: [s1, s2, s3], win, mult });
        if (mult >= 8) io.emit('chat:event', { msg: `🎰 ${p.nick} trafił ${s1}${s2}${s3} i wygrał $${win.toLocaleString()}!`, style: 'win' });
        broadcastLeaderboard();
    });

    socket.on('disconnect', () => {
        if (onlinePlayers[socket.id]) {
            delete onlinePlayers[socket.id];
            if (!pokerTable.active) delete pokerTable.seats[socket.id];
            broadcastLeaderboard();
            broadcastPokerTable(pokerTable.stage === 5);
        }
    });
});

const PORT = process.env.PORT || 3000;
server.listen(PORT, () => console.log(`🎰 Royal Casino v2 działa na porcie ${PORT}`));