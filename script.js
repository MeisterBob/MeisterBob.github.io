let wmConfig = {
    groups: {},
    matches: [],
    knockout: [],
    teamFlags: {}
};

document.addEventListener('DOMContentLoaded', () => {
    initApp();
});

async function initApp() {
    try {
        const response = await fetch('https://api.fifa.com/api/v3/calendar/matches?language=de&count=500&idSeason=285023');
        const data = await response.json();
        const results = data.Results || [];

        // Transformation der Spiele aus der FIFA-API
        wmConfig.matches = results.map(m => {
            // FIFA liefert UTC-Daten, wir extrahieren Datum und Zeit für convertToCEST
            const dateObj = new Date(m.Date);
            const dateStr = dateObj.toISOString().split('T')[0];
            const timeStr = dateObj.toISOString().split('T')[1].substring(0, 5);
            const converted = convertToCEST(dateStr, timeStr, "UTC");

            const homeName = m.Home?.TeamName?.[0]?.Description || m.PlaceHolderA || "TBD";
            const awayName = m.Away?.TeamName?.[0]?.Description || m.PlaceHolderB || "TBD";

            if (m.Home?.PictureUrl) {
                const formattedUrl = m.Home.PictureUrl.replace('{format}', 'sq').replace('{size}', '1');
                wmConfig.teamFlags[homeName] = formattedUrl;
            }
            if (m.Away?.PictureUrl) {
                const formattedUrl = m.Away.PictureUrl.replace('{format}', 'sq').replace('{size}', '1');
                wmConfig.teamFlags[awayName] = formattedUrl;
            }

            return {
                group: m.GroupName?.[0]?.Description ? m.GroupName[0].Description.split(' ').pop() : null,
                home: homeName,
                away: awayName,
                MatchStatus: m.MatchStatus,
                scoreHome: m.HomeTeamScore,
                scoreAway: m.AwayTeamScore,
                date: converted.date,
                time: converted.time,
                round: m.StageName?.[0]?.Description || "Vorrunde"
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

        renderGroupPhase();
        renderBestThirds();
        renderKnockoutPhase();
        checkAutoCollapse();
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
    const qualifiedThirdNames = getThirdsRanking().slice(0, 8).map(t => t.name);

    Object.keys(wmConfig.groups).sort().forEach(groupName => {
        const tableData = calculateTable(groupName);
        const card = document.createElement('div');
        card.className = 'group-card';

        let html = `<h3>Gruppe ${groupName}</h3><table>
            <thead><tr><th>Team</th><th>Diff</th><th>Pkt</th></tr></thead><tbody>`;

        tableData.forEach((t, index) => {
            const isTopTwo = index <= 1;
            const isBestThird = index === 2 && qualifiedThirdNames.includes(t.name);
            const rowClass = (isTopTwo || isBestThird) ? "qualified" : "";

            html += `<tr class="${rowClass}">`
                + `<td class="team-name">${getFlagHtml(t.name)}${t.name}</td>`
                + `<td>${t.diff}</td>`
                + `<td>${t.pts}</td>`
                + `</tr>`;
        });

        html += `</tbody></table><div class="match-list">`;

        wmConfig.matches.filter(m => m.group === groupName).forEach(m => {
            const isLive = m.MatchStatus === 3;
            const sH = m.scoreHome ?? (isLive ? 0 : '-');
            const sA = m.scoreAway ?? (isLive ? 0 : '-');
            const timeInfo = m.date ? `<small style="display:block; color:#888; font-size:0.8em;">${m.date} ${m.time || ''}</small>` : '';
            const matchTime = parseCESTDateTime(m.date, m.time);
            const isUpcoming24h = matchTime && matchTime > now && matchTime <= oneDayLater;
            const todayClass = (isLive || isUpcoming24h) ? 'today-match' : '';
            const liveBadgeHtml = isLive ? `<span class="live-badge">LIVE</span>` : '';
            const homeTeamHtml = `<span class="team-name-text">${m.home}</span>${getFlagHtml(m.home)}`;
            const awayTeamHtml = `${getFlagHtml(m.away)}<span class="team-name-text">${m.away}</span>`;

            // If live, the badge replaces 'vs'. Otherwise, 'vs' is shown.
            const separatorHtml = isLive ? liveBadgeHtml : `<span class="vs-text">vs</span>`;

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
                <span class="score">${sH}:${sA}</span>
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

    let html = `<table><thead><tr><th>#</th><th>Gruppe</th><th>Team</th><th>S</th><th>U</th><th>N</th><th>Tore</th><th>Diff</th><th>Pkt</th></tr></thead><tbody>`;

    thirds.forEach((t, index) => {
        html += `
        <tr class="${(index < 8) ? 'qualified' : 'eliminated'}">
            <td>${index + 1}.</td>
            <td>${t.group}</td>
            <td class="team-name">${getFlagHtml(t.name)}${t.name}</td>
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
    const qualifiedThirds = getThirdsRanking().slice(0, 8);
    const assignedThirds = new Set();

    // Wir filtern Spiele ohne Gruppenzuordnung (K.o.-Spiele) aus den geladenen Daten
    const koMatches = wmConfig.matches.filter(m => !m.group);

    // Runden-Reihenfolge definieren
    const roundOrder = {
        "Sechzehntelfinale": 1,
        "Round of 32": 1,
        "Achtelfinale": 2,
        "Round of 16": 2,
        "Viertelfinale": 3,
        "Halbfinale": 4,
        "Spiel um Platz drei": 5,
        "Finale": 5,
    };

    const uniqueOrders = [...new Set(koMatches.map(m => roundOrder[m.round] || 99))].sort((a, b) => a - b);

    uniqueOrders.forEach(order => {
        const matchesInColumn = koMatches.filter(m => (roundOrder[m.round] || 99) === order);
        if (order === 5) {
            // Sortierung innerhalb der Spalte: Finale oben, Platz 3 unten
            matchesInColumn.sort((a, b) => a.round === "Finale" ? -1 : 1);
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
            if (m.round === "Spiel um Platz drei") {
                wrapper.classList.add('third-place-wrapper');
            }
            if (m.round === "Finale") {
                wrapper.classList.add('finale-wrapper');
            }

            const matchEl = document.createElement('div');
            matchEl.className = `knockout-match ${isTodayOrSoon ? 'today-match' : ''}`; // knockout-match statt match group-card
            const timeInfo = m.date ? `<small style="display:block; color:#888; font-size:0.8em;">${m.date} ${m.time || ''}</small>` : '';
            const liveBadgeHtml = isLive ? `<span class="live-badge">LIVE</span>` : '';

            // Platzhalter wie "1. Gruppe A" durch echte Teamnamen ersetzen
            const homeDisplay = resolveKnockoutTeam(m.home, rankings, qualifiedThirds, assignedThirds);
            const awayDisplay = resolveKnockoutTeam(m.away, rankings, qualifiedThirds, assignedThirds);

            matchEl.innerHTML = `
                <span class="teams-ko">
                    <span class="team-name-wrapper ${m.home.startsWith("3") ? 'third-place' : ''}">
                        <span class="team-name-text">${homeDisplay}</span>
                        ${getFlagHtml(homeDisplay)}
                    </span>
                    ${isLive ? liveBadgeHtml : `<span class="vs-text">vs</span>`}
                    <span class="team-name-wrapper ${m.away.startsWith("3") ? 'third-place' : ''}">
                        ${getFlagHtml(awayDisplay)}
                        <span class="team-name-text">${awayDisplay}</span>
                    </span>
                </span>
                ${timeInfo}
                <span class="score">${m.scoreHome ?? (isLive ? 0 : '-')}:${m.scoreAway ?? (isLive ? 0 : '-')}</span>`;

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
 * Prüft, ob alle Gruppenspiele abgeschlossen sind
 */
function isGroupFinished(groupName) {
    const groupMatches = wmConfig.matches.filter(m => m.group === groupName);
    return groupMatches.length > 0 && groupMatches.every(m => m.scoreHome !== null);
}

/**
 * Löst Platzhalter (z.B. "1A") in Teamnamen auf, wenn die Gruppe beendet ist
 */
function resolveKnockoutTeam(name, rankings, qualifiedThirds = [], assignedThirds = new Set()) {
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

    const complexThirdMatch = name.match(/^3([A-L\/]+)$/i);
    if (complexThirdMatch) {
        const possibleGroups = complexThirdMatch[1].replace(/\//g, '').toUpperCase().split('');
        const candidate = qualifiedThirds.find(t =>
            possibleGroups.includes(t.group) &&
            !assignedThirds.has(t.name)
        );

        if (candidate) {
            assignedThirds.add(candidate.name);
            return candidate.name;
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

/**
 * Prüft, ob ein Spiel basierend auf seiner Anstoßzeit "live" ist (innerhalb der letzten 2 Stunden gestartet).
 */
function isMatchLive(matchDateStr, matchTimeStr, currentTime) {
    const matchStartTime = parseCESTDateTime(matchDateStr, matchTimeStr);
    if (!matchStartTime) return false;
    const twoHoursAgo = new Date(currentTime.getTime() - (2 * 60 * 60 * 1000));
    return matchStartTime > twoHoursAgo && matchStartTime <= currentTime;
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
