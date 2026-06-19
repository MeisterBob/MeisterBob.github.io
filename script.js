const tournaments = [
    { season: 255711, title: 'Weltmeisterschaft 2022', qualified_3rds: 0 },
    { season: 285026, title: 'Frauen-Weltmeisterschaft 2023', qualified_3rds: 0 },
    { season: 285023, title: 'Weltmeisterschaft 2026', qualified_3rds: 8 },
    { season: 292937, title: 'U-17 Weltmeisterschaft 2026', qualified_3rds: 8 },
    { season: 291518, title: 'U-20-Frauen-Weltmeisterschaft', qualified_3rds: 4 },
    // { season: 292312, title: 'Qualifikation Frauen-Weltmeisterschaft 2027', qualified_3rds: 0 },
]
const matchUrl = (season) => `https://api.fifa.com/api/v3/calendar/matches?language=de&count=500&idSeason=${season}`;
const watchUrl = (season) => `https://api.fifa.com/api/v3/watch/season/${season}?count=500&language=de`;

const flagCache = {};

let wmConfig = {
    tournament: tournaments[2],
    groups: {},
    matches: [],
    knockout: [],
    teamFlags: {},
    matchIdToTv: {}
};
let liveUpdateTimeout = null;
let overallTableSort = { key: 'pts', dir: -1 };

const tvLogo = {
    DasErste: 'ard.png',
    ZDF: 'zdf.webp',
    'FUSSBALL.TV 1': 'magenta.webp',
    'FUSSBALL.TV 2': 'magenta.webp',
    'FUSSBALL.TV 3': 'magenta.webp',
};
document.addEventListener('DOMContentLoaded', () => {
    setupTournamentSelector();
    initApp();
});

function setupTournamentSelector() {
    const selector = document.getElementById('tournament-selector');
    if (!selector) return;

    Object.entries(tournaments).forEach(([key, t]) => {
        const option = document.createElement('option');
        option.value = key;
        option.textContent = t.title;
        if (t === wmConfig.tournament) option.selected = true;
        selector.appendChild(option);
    });

    selector.addEventListener('change', (e) => {
        wmConfig.tournament = tournaments[e.target.value];
        initApp();
    });
}

async function initApp(isLiveUpdate = false) {
    if (liveUpdateTimeout) clearTimeout(liveUpdateTimeout);

    try {
        // TV-Informationen (Broadcaster) abrufen
        if (!isLiveUpdate) {
            wmConfig.matchIdToTv = {};
            try {
                const watchRes = await fetch(watchUrl(wmConfig.tournament.season));
                if (watchRes.ok) {
                    const watchData = await watchRes.json();
                    if (watchData?.Results) {
                        watchData.Results.forEach(wm => {
                            if (wm.IdCountry === "GER") {
                                wm.Matches.forEach(m => {
                                    const uniqueBroadcasterKeys = new Set();
                                    m.Sources.forEach(source => {
                                        uniqueBroadcasterKeys.add(source.Name);
                                    });

                                    const tvLogosHtml = Array.from(uniqueBroadcasterKeys)
                                        .map(key => tvLogo[key] ? `<img src="${tvLogo[key]}" alt="${key}" class="tv-logo">` : null)
                                        .join('');

                                    if (tvLogosHtml) {
                                        wmConfig.matchIdToTv[m.IdMatch] = tvLogosHtml;
                                    }
                                })
                            }
                        });
                    }
                }
            } catch (e) { console.warn("Watch-Daten konnten nicht geladen werden.", e); }
        }

        const response = await fetch(matchUrl(wmConfig.tournament.season));
        const data = await response.json();
        const results = data.Results || [];

        document.getElementById('tournament-title').textContent = results[0].SeasonName[0].Description;

        // Neue Daten verarbeiten — DOM bleibt bis hierher unverändert
        wmConfig.teamFlags = {};
        wmConfig.matches = results.map(m => {
            // FIFA liefert UTC-Daten, wir extrahieren Datum und Zeit für convertToCEST
            const dateObj = new Date(m.Date);
            const dateStr = dateObj.toISOString().split('T')[0];
            const timeStr = dateObj.toISOString().split('T')[1].substring(0, 5);
            const converted = convertToCEST(dateStr, timeStr, "UTC");

            const homeName = m.Home?.TeamName?.[0]?.Description || m.PlaceHolderA || "TBD";
            const awayName = m.Away?.TeamName?.[0]?.Description || m.PlaceHolderB || "TBD";

            const extractMatchNum = (str) => {
                if (typeof str !== 'string') return null;
                const match = str.match(/(\d+)/);
                return match ? parseInt(match[1]) : null;
            };

            if (m.Home?.PictureUrl) {
                const url = m.Home.PictureUrl.replace('{format}', 'sq').replace('{size}', '1');
                wmConfig.teamFlags[homeName] = url;
                if (!flagCache[url]) { flagCache[url] = new Image(); flagCache[url].src = url; }
            }
            if (m.Away?.PictureUrl) {
                const url = m.Away.PictureUrl.replace('{format}', 'sq').replace('{size}', '1');
                wmConfig.teamFlags[awayName] = url;
                if (!flagCache[url]) { flagCache[url] = new Image(); flagCache[url].src = url; }
            }

            return {
                group: m.GroupName?.[0]?.Description ? m.GroupName[0].Description.split(' ').pop() : null,
                home: homeName,
                away: awayName,
                MatchNumber: m.MatchNumber,
                MatchStatus: m.MatchStatus,
                scoreHome: m.HomeTeamScore,
                scoreAway: m.AwayTeamScore,
                scoreHomePenalty: m.HomeTeamPenaltyScore,
                scoreAwayPenalty: m.AwayTeamPenaltyScore,
                date: converted.date,
                time: converted.time,
                parentMatchA: extractMatchNum(m.PlaceHolderA),
                parentMatchB: extractMatchNum(m.PlaceHolderB),
                round: m.StageName?.[0]?.Description || "Vorrunde",
                // TV-Logos nur für anstehende (1) oder Live-Spiele (3) anzeigen
                tv: (m.MatchStatus === 1 || m.MatchStatus === 3) ? (wmConfig.matchIdToTv[m.IdMatch] || "") : ""
            };
        });

        // Dynamische Generierung der Gruppen-Objekte für die Tabellenberechnung
        wmConfig.groups = {};
        wmConfig.matches.forEach(m => {
            if (m.group) {
                if (!wmConfig.groups[m.group]) wmConfig.groups[m.group] = [];

                // Wir fügen nur echte Teamnamen hinzu (keine Platzhalter wie "1. Gruppe B")
                [m.home, m.away].forEach(team => {
                    if (team && !team.includes('Gruppe') && !wmConfig.groups[m.group].includes(team)) {
                        wmConfig.groups[m.group].push(team);
                    }
                });
            }
        });

        // DOM erst jetzt leeren und neu befüllen — alle Daten sind bereit
        document.getElementById('groups-container').innerHTML = '';
        document.getElementById('knockout-container').innerHTML = '';

        if (!isLiveUpdate) {
            overallTableSort = { key: 'pts', dir: -1 };
        }

        renderGroupPhase();
        const thirdsSection = document.getElementById('best-thirds-container')?.closest('.section');
        if (wmConfig.tournament.qualified_3rds > 0) {
            if (thirdsSection) thirdsSection.style.display = 'block';
            renderBestThirds();
        } else {
            if (thirdsSection) thirdsSection.style.display = 'none';
        }
        renderKnockoutPhase();
        renderOverallTable();

        if (!isLiveUpdate) {
            checkAutoCollapse();
        }

        if (wmConfig.matches.some(m => m.MatchStatus === 3)) {
            liveUpdateTimeout = setTimeout(() => initApp(true), 60000);
        }
    } catch (error) {
        console.error("Fehler beim Laden der WM-Daten:", error);
        document.getElementById('app').innerHTML = `<p style="text-align:center; color:red;">Daten konnten nicht geladen werden.</p>`;
    }
}

function calculateTable(groupName) {
    const teams = wmConfig.groups[groupName];
    const table = teams.map(team => ({
        name: team, matches: 0, won: 0, drawn: 0, lost: 0, goalsFor: 0, goalsAgainst: 0, diff: 0, pts: 0
    }));

    wmConfig.matches
        .filter(m => m.group === groupName && m.scoreHome !== null)
        .forEach(m => {
            const home = table.find(t => t.name === m.home);
            const away = table.find(t => t.name === m.away);

            home.matches++; away.matches++;
            home.goalsFor += m.scoreHome; home.goalsAgainst += m.scoreAway;
            away.goalsFor += m.scoreAway; away.goalsAgainst += m.scoreHome;

            if (m.scoreHome > m.scoreAway) {
                home.won++; home.pts += 3; away.lost++;
            } else if (m.scoreHome < m.scoreAway) {
                away.won++; away.pts += 3; home.lost++;
            } else {
                home.drawn++; away.drawn++; home.pts += 1; away.pts += 1;
            }
            home.diff = home.goalsFor - home.goalsAgainst;
            away.diff = away.goalsFor - away.goalsAgainst;
        });

    // Sortierung nach FIFA-Regeln: Punkte -> Diff -> Tore
    return table.sort((a, b) => b.pts - a.pts || b.diff - a.diff || b.goalsFor - a.goalsFor);
}

/**
 * Berechnet das Ranking aller Gruppendritten über alle Gruppen hinweg
 */
function getThirdsRanking() {
    const thirds = [];
    for (const groupName in wmConfig.groups) {
        const table = calculateTable(groupName);
        if (table && table.length >= 3) {
            thirds.push({ ...table[2], group: groupName });
        }
    }
    return thirds.sort((a, b) => b.pts - a.pts || b.diff - a.diff || b.goalsFor - a.goalsFor);
}

function renderGroupPhase() {
    const container = document.getElementById('groups-container');
    const now = new Date();
    const oneDayLater = new Date(now.getTime() + 24 * 60 * 60 * 1000);

    // Namen der aktuell 8 besten Gruppendritten für die Highlighting-Logik ermitteln
    const qualifiedThirdNames = getThirdsRanking().slice(0, wmConfig.tournament.qualified_3rds).map(t => t.name);

    Object.keys(wmConfig.groups).sort().forEach(groupName => {
        const tableData = calculateTable(groupName);
        const card = document.createElement('div');
        card.className = 'group-card';

        let html = `<h3>Gruppe ${groupName}</h3><table>
            <thead><tr><th>Team</th><th>Diff</th><th>Pkt</th></tr></thead><tbody>`;

        // Ermitteln, welche Teams in dieser Gruppe gerade live spielen
        const liveTeamsInGroup = new Set();
        wmConfig.matches.filter(m => m.group === groupName).forEach(m => {
            if (m.MatchStatus === 3) {
                liveTeamsInGroup.add(m.home);
                liveTeamsInGroup.add(m.away);
            }
        });

        tableData.forEach((t, index) => {
            const isTopTwo = index <= 1;
            const isBestThird = index === 2 && qualifiedThirdNames.includes(t.name);
            const rowClass = (isTopTwo || isBestThird) ? "qualified" : "";

            const liveBadgeForTable = liveTeamsInGroup.has(t.name) ? `<span class="live-badge">LIVE</span>` : '';
            html += `<tr class="${rowClass}">`
                + `<td class="team-name">${getFlagHtml(t.name)}${t.name} ${liveBadgeForTable}</td>`
                + `<td>${t.diff}</td>`
                + `<td>${t.pts}</td>`
                + `</tr>`;
        });

        html += `</tbody></table><div class="match-list">`;

        wmConfig.matches.filter(m => m.group === groupName).forEach(m => {
            const isLive = m.MatchStatus === 3;
            const tvBadge = m.tv ? `<span class="tv-info">${m.tv}</span>` : '';
            const timeInfo = m.date ? `<small style="display:block; color:#888; font-size:0.8em;">${m.date} ${m.time || ''} ${tvBadge}</small>` : '';
            const matchTime = parseCESTDateTime(m.date, m.time);
            const isUpcoming24h = matchTime && matchTime > now && matchTime <= oneDayLater;
            const todayClass = (isLive || isUpcoming24h) ? 'today-match' : '';
            const liveBadgeHtml = isLive ? `<span class="live-badge">LIVE</span>` : '';
            const homeTeamHtml = `<span class="team-name-text">${m.home}</span>${getFlagHtml(m.home)}`;
            const awayTeamHtml = `${getFlagHtml(m.away)}<span class="team-name-text">${m.away}</span>`;

            // If live, the badge replaces 'vs'. Otherwise, 'vs' is shown.
            const separatorHtml = isLive ? liveBadgeHtml : `<span class="vs-text">vs</span>`;
            const scoreHtml = m.MatchStatus === 1 ? '' : `<span class="score">${m.scoreHome ?? (isLive ? 0 : '-')}:${m.scoreAway ?? (isLive ? 0 : '-')}</span>`;

            html += `
            <div class="match ${todayClass}">
                <div>
                    <span class="teams">
                        <span class="team-name-wrapper">${homeTeamHtml}</span>
                        ${separatorHtml}
                        <span class="team-name-wrapper">${awayTeamHtml}</span>
                    </span>
                    <span class="time">${timeInfo}</span>
                </div>
                ${scoreHtml}
                <span class="MatchNumber">${m.MatchNumber}</span>
            </div>`;
        });

        card.innerHTML = html + `</div>`;
        container.appendChild(card);
    });
}

function renderBestThirds() {
    const thirds = getThirdsRanking();
    const container = document.getElementById('best-thirds-container');
    if (!container) return;

    // Ermitteln, welche Teams aktuell live spielen (Status 3)
    const liveTeams = new Set();
    wmConfig.matches.forEach(m => {
        if (m.MatchStatus === 3) {
            liveTeams.add(m.home);
            liveTeams.add(m.away);
        }
    });

    let html = `<table><thead><tr><th>#</th><th>Gruppe</th><th>Team</th><th>Sp</th><th>S</th><th>U</th><th>N</th><th>Tore</th><th>Diff</th><th>Pkt</th></tr></thead><tbody>`;

    thirds.forEach((t, index) => {
        const liveBadge = liveTeams.has(t.name) ? `<span class="live-badge">LIVE</span>` : '';
        html += `
        <tr class="${(index < wmConfig.tournament.qualified_3rds) ? 'qualified' : 'eliminated'}">
            <td>${index + 1}.</td>
            <td>${t.group}</td>
            <td class="team-name">${getFlagHtml(t.name)}${t.name} ${liveBadge}</td>
            <td>${t.won + t.drawn + t.lost}</td>
            <td>${t.won}</td>
            <td>${t.drawn}</td>
            <td>${t.lost}</td>
            <td>${t.goalsFor}:${t.goalsAgainst}</td>
            <td>${t.diff}</td>
            <td>${t.pts}</td>
        </tr>`;
    });
    container.innerHTML = html + `</tbody></table>`;
}

function renderKnockoutPhase() {
    const container = document.getElementById('knockout-container');
    const now = new Date();
    const oneDayLater = new Date(now.getTime() + 24 * 60 * 60 * 1000);

    // Rankings berechnen, um Qualifikanten für die KO-Runde zu bestimmen
    const rankings = {};
    for (const groupName in wmConfig.groups) {
        rankings[groupName] = calculateTable(groupName);
    }

    // Namen der aktuell 8 besten Gruppendritten für die KO-Logik
    const qualifiedThirds = getThirdsRanking().slice(0, wmConfig.tournament.qualified_3rds);
    const assignedThirds = new Set();

    // Wir filtern Spiele ohne Gruppenzuordnung (K.o.-Spiele) aus den geladenen Daten
    const koMatches = wmConfig.matches.filter(m => !m.group);

    // Runden-Reihenfolge definieren
    const roundOrder = {
        "Round of 32": 1,
        "Round of 16": 2,
        "Quarter-final": 3,
        "Semi-final": 4,
        "Play-off for third place": 5,
        "Final": 5,

        "Sechzehntelfinale": 1,
        "Achtelfinale": 2,
        "Viertelfinale": 3,
        "Halbfinale": 4,
        "Spiel um Platz drei": 5,
        "Finale": 5,
    };

    const uniqueOrders = [...new Set(koMatches.map(m => roundOrder[m.round] || 99))].sort((a, b) => a - b);

    // Create a lookup map and determine bracket order starting from the Final
    const matchByNumber = new Map(koMatches.map(m => [m.MatchNumber, m]));
    const bracketOrder = [];
    const finalMatch = koMatches.find(m => m.round === "Finale" || m.round === "Final");

    if (finalMatch) {
        const queue = [finalMatch];
        while (queue.length > 0) {
            const m = queue.shift();
            if (!m) continue;
            bracketOrder.push(m.MatchNumber);
            // Add parents to queue: ParentA (top) then ParentB (bottom)
            // This BFS approach ensures we discover matches round-by-round in visual order
            if (m.parentMatchA) queue.push(matchByNumber.get(m.parentMatchA));
            if (m.parentMatchB) queue.push(matchByNumber.get(m.parentMatchB));
        }
    }

    uniqueOrders.forEach(order => {
        const matchesInColumn = koMatches.filter(m => (roundOrder[m.round] || 99) === order);

        // Sort matches based on their position in the bracket tree
        matchesInColumn.sort((a, b) => {
            const indexA = bracketOrder.indexOf(a.MatchNumber);
            const indexB = bracketOrder.indexOf(b.MatchNumber);
            // If not in bracket tree (like 3rd place), put at the end
            return (indexA === -1 ? 999 : indexA) - (indexB === -1 ? 999 : indexB);
        });

        if (order === 5) {
            // Sortierung innerhalb der Spalte: Finale oben, Platz 3 unten
            matchesInColumn.sort((a, b) => (a.round === "Finale" || a.round === "Final") ? -1 : 1);
        }

        const roundDiv = document.createElement('div');
        roundDiv.className = 'round-column';

        let displayTitle = matchesInColumn[0].round;
        if (order === 5) displayTitle = "Finale";

        roundDiv.innerHTML = `<h3>${displayTitle}</h3>`;

        matchesInColumn.forEach(m => {
            const isLive = m.MatchStatus === 3;
            const matchTime = parseCESTDateTime(m.date, m.time);
            const isUpcoming24h = matchTime && matchTime > now && matchTime <= oneDayLater;
            const isTodayOrSoon = isLive || isUpcoming24h;

            const wrapper = document.createElement('div');
            wrapper.className = 'match-wrapper';
            if (m.round === "Spiel um Platz drei" || m.round === "Play-off for third place") {
                wrapper.classList.add('third-place-wrapper');
            }
            if (m.round === "Finale" || m.round === "Final") {
                wrapper.classList.add('finale-wrapper');
            }

            const matchEl = document.createElement('div');
            matchEl.className = `knockout-match ${isTodayOrSoon ? 'today-match' : ''}`; // knockout-match statt match group-card
            const tvBadge = m.tv ? `<span class="tv-info">${m.tv}</span>` : '';
            const timeInfo = m.date ? `<small style="display:block; color:#888; font-size:0.8em;">${m.date} ${m.time || ''} ${tvBadge}</small>` : '';
            const liveBadgeHtml = isLive ? `<span class="live-badge">LIVE</span>` : '';

            // Platzhalter wie "1. Gruppe A" durch echte Teamnamen ersetzen
            const homeDisplay = resolveKnockoutTeam(m.home, rankings);
            const awayDisplay = resolveKnockoutTeam(m.away, rankings);

            let score = `${m.scoreHome ?? (isLive ? 0 : '-')}:${m.scoreAway ?? (isLive ? 0 : '-')}`;
            if (m.scoreHomePenalty + m.scoreAwayPenalty > 0)
                score += ' (' + m.scoreHomePenalty + ':' + m.scoreAwayPenalty + ')';
            const scoreHtml = m.MatchStatus === 1 ? '' : `<span class="score">${score}</span>`;

            matchEl.innerHTML = `
                <span class="teams-ko">
                    <span class="team-name-wrapper ${m.home.startsWith("3") ? 'third-place' : ''}">
                        <span class="team-name-text">${homeDisplay}</span>
                        ${getFlagHtml(homeDisplay)}
                    </span>
                    ${isLive ? liveBadgeHtml : `<span class="vs-text">vs</span>`}
                    <span class="team-name-wrapper">
                        ${getFlagHtml(awayDisplay)}
                        <span class="team-name-text">${awayDisplay}</span>
                    </span>
                </span>
                ${timeInfo}
                ${scoreHtml}
                <span class="MatchNumber">${m.MatchNumber}</span>`;

            wrapper.appendChild(matchEl);
            roundDiv.appendChild(wrapper);
        });
        container.appendChild(roundDiv);
    });
}

/**
 * Erzeugt den HTML-Code für eine Landesflagge
 */
function getFlagHtml(teamName) {
    const logoUrl = "https://digitalhub.fifa.com/m/1a33060ce1c1c4d6/original/WC26_Logo.png";
    const url = wmConfig.teamFlags[teamName] || logoUrl;
    return `<img src="${url}" class="flag" alt="${teamName || 'TBD'}">`;
}

/**
 * Schaltet die Sichtbarkeit einer Sektion um
 */
function toggleSection(id) {
    const content = document.getElementById(id);
    if (!content) return;
    const header = content.previousElementSibling;
    content.classList.toggle('collapsed-content');
    header.classList.toggle('collapsed-header');
}

/**
 * Prüft, ob alle Gruppenspiele abgeschlossen sind und klappt die Sektion ggf. ein
 */
function checkAutoCollapse() {
    const groupMatches = wmConfig.matches.filter(m => m.group !== null);
    const koMatches = wmConfig.matches.filter(m => m.group === null);

    if (groupMatches.length > 0 && groupMatches.every(m => m.scoreHome !== null)) {
        const groups = document.getElementById('groups-container');
        if (groups && !groups.classList.contains('collapsed-content')) toggleSection('groups-container');
    }
    if (koMatches.length > 0 && koMatches.some(m => m.scoreHome !== null)) {
        const thirds = document.getElementById('best-thirds-container');
        if (thirds && !thirds.classList.contains('collapsed-content')) toggleSection('best-thirds-container');
    }
    if (koMatches.length > 0 && koMatches.every(m => m.home === 'TBD' && m.away === 'TBD')) {
        const ko = document.getElementById('knockout-container');
        if (ko && !ko.classList.contains('collapsed-content')) toggleSection('knockout-container');
    }
}

/**
 * Löst Platzhalter (z.B. "1A") in Teamnamen auf, wenn die Gruppe beendet ist
 */
function resolveKnockoutTeam(name, rankings) {
    if (!name || name === "TBD") return "TBD";

    const match = name.match(/^([12])\.\s+Gruppe\s+([A-L])$/) || name.match(/^([12])([A-L])$/);
    if (match) {
        const rank = parseInt(match[1]);
        const group = match[2];
        if (rankings[group]) {
            const team = rankings[group][rank - 1];
            if (!team) return name;
            return team.name;
        }
    }

    return name;
}

/**
 * Parst ein Datum und eine Uhrzeit im CEST-Format und gibt ein Date-Objekt zurück.
 * @param {string} dateStr - Datum im Format 'TT.MM.JJJJ'
 * @param {string} timeStr - Uhrzeit im Format 'HH:MM CEST'
 * @returns {Date|null} - Das geparste Date-Objekt oder null bei ungültigen Eingaben.
 */
function parseCESTDateTime(dateStr, timeStr) {
    if (!dateStr || !timeStr) return null;

    const [day, month, year] = dateStr.split('.').map(Number);
    const [hours, minutes] = timeStr.replace(' CEST', '').split(':').map(Number);

    // Month is 0-indexed in JavaScript Date object
    return new Date(year, month - 1, day, hours, minutes);
}

function renderOverallTable() {
    const container = document.getElementById('table-container');
    if (!container) return;

    const teamStats = {};
    const getOrCreate = (name) => {
        if (!teamStats[name]) {
            teamStats[name] = { name, matches: 0, won: 0, drawn: 0, lost: 0, goalsFor: 0, goalsAgainst: 0, diff: 0, pts: 0 };
        }
        return teamStats[name];
    };

    wmConfig.matches.forEach(m => {
        if (m.scoreHome === null || m.scoreAway === null) return;
        if (!m.home || !m.away || m.home === 'TBD' || m.away === 'TBD') return;
        if (m.home.includes('Gruppe') || m.away.includes('Gruppe')) return;

        const home = getOrCreate(m.home);
        const away = getOrCreate(m.away);

        home.matches++; away.matches++;
        home.goalsFor += m.scoreHome; home.goalsAgainst += m.scoreAway;
        away.goalsFor += m.scoreAway; away.goalsAgainst += m.scoreHome;

        const hasPenalties = ((m.scoreHomePenalty ?? 0) + (m.scoreAwayPenalty ?? 0)) > 0;

        if (m.scoreHome > m.scoreAway) {
            home.won++; home.pts += 3; away.lost++;
        } else if (m.scoreHome < m.scoreAway) {
            away.won++; away.pts += 3; home.lost++;
        } else if (hasPenalties) {
            if ((m.scoreHomePenalty ?? 0) > (m.scoreAwayPenalty ?? 0)) {
                home.won++; home.pts += 3; away.lost++;
            } else {
                away.won++; away.pts += 3; home.lost++;
            }
        } else {
            home.drawn++; home.pts += 1;
            away.drawn++; away.pts += 1;
        }

        home.diff = home.goalsFor - home.goalsAgainst;
        away.diff = away.goalsFor - away.goalsAgainst;
    });

    const data = Object.values(teamStats).map(t => ({
        ...t,
        ppg: t.matches > 0 ? t.pts / t.matches : 0
    }));

    const { key, dir } = overallTableSort;
    data.sort((a, b) => {
        const va = a[key], vb = b[key];
        if (typeof va === 'string') return dir * va.localeCompare(vb, 'de');
        if (va !== vb)
            return dir * (va - vb);
        if (a['pts'] !== b['pts'])
            return dir * (a['pts'] - b['pts']);
        if (a['diff'] !== b['diff'])
            return dir * (a['diff'] - b['diff']);
        if (a['goalsFor'] !== b['goalsFor'])
            return dir * (a['goalsFor'] - b['goalsFor']);
        if (a['won'] !== b['won'])
            return dir * (a['won'] - b['won']);
        if (a['drawn'] !== b['drawn'])
            return dir * (a['drawn'] - b['drawn']);
        if (a['lost'] !== b['lost'])
            return -dir * (a['lost'] - b['lost']);
        if (a['matches'] !== b['matches'])
            return -dir * (a['matches'] - b['matches']);
    });

    const columns = [
        { key: 'name', label: 'Team', defaultDir: 1 },
        { key: 'matches', label: 'Sp', defaultDir: -1 },
        { key: 'won', label: 'S', defaultDir: -1 },
        { key: 'drawn', label: 'U', defaultDir: -1 },
        { key: 'lost', label: 'N', defaultDir: -1 },
        { key: 'goalsFor', label: 'Tore', defaultDir: -1 },
        { key: 'diff', label: 'Diff', defaultDir: -1 },
        { key: 'pts', label: 'Pkt', defaultDir: -1 },
        { key: 'ppg', label: 'Pkt/Sp', defaultDir: -1 },
    ];

    let thead = `<thead><tr>`;
    columns.forEach(col => {
        const isActive = overallTableSort.key === col.key;
        const arrow = isActive ? (overallTableSort.dir === -1 ? ' ▼' : ' ▲') : '';
        thead += `<th style="cursor:pointer;" onclick="sortOverallTable('${col.key}', ${col.defaultDir})">${col.label}${arrow}</th>`;
    });
    thead += `</tr></thead>`;

    let tbody = `<tbody>`;
    data.forEach((t, i) => {
        const diffStr = t.diff > 0 ? `+${t.diff}` : `${t.diff}`;
        tbody += `<tr>
            <td class="team-name">${getFlagHtml(t.name)}${t.name}</td>
            <td>${t.matches}</td>
            <td>${t.won}</td>
            <td>${t.drawn}</td>
            <td>${t.lost}</td>
            <td>${t.goalsFor}:${t.goalsAgainst}</td>
            <td>${diffStr}</td>
            <td>${t.pts}</td>
            <td>${t.ppg.toFixed(2)}</td>
        </tr>`;
    });
    tbody += `</tbody>`;

    container.innerHTML = `<div class="group-card"><table>${thead}${tbody}</table></div>`;
}

function sortOverallTable(key, defaultDir) {
    if (overallTableSort.key === key) {
        overallTableSort.dir *= -1;
    } else {
        overallTableSort.key = key;
        overallTableSort.dir = defaultDir;
    }
    renderOverallTable();
}

function convertToCEST(dateStr, timeStr, timezoneStr) {
    if (!dateStr || !timeStr) return { date: dateStr, time: timeStr };

    let offset = "Z";
    if (timezoneStr) {
        const cleanOffset = timezoneStr.replace("UTC", "").trim();
        if (cleanOffset && cleanOffset !== "Z") {
            const sign = cleanOffset.startsWith("-") ? "-" : "+";
            const val = cleanOffset.replace(/[+-]/, "");
            const parts = val.split(":");
            const hh = parts[0].padStart(2, "0");
            const mm = (parts[1] || "00").padStart(2, "0");
            offset = `${sign}${hh}:${mm}`;
        }
    }

    try {
        const dateObj = new Date(`${dateStr}T${timeStr}:00${offset}`);
        if (isNaN(dateObj.getTime())) throw new Error();

        const dateFormatted = new Intl.DateTimeFormat('de-DE', {
            timeZone: 'Europe/Berlin',
            day: '2-digit',
            month: '2-digit',
            year: 'numeric'
        }).format(dateObj);

        const timeFormatted = new Intl.DateTimeFormat('de-DE', {
            timeZone: 'Europe/Berlin',
            hour: '2-digit',
            minute: '2-digit',
            hour12: false
        }).format(dateObj);

        return { date: dateFormatted, time: timeFormatted };
    } catch (e) {
        return { date: dateStr, time: timeStr };
    }
}
