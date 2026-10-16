/* ============================================================
   PDP MORNING ASSEMBLY DUTY PLANNER
   Data is stored in a file called data.json inside your GitHub
   repo. The app reads it on startup and writes it (after a
   short pause) whenever something changes.
   ============================================================ */

// ---------- SETTINGS: ONLY THIS LINE ----------
// Address of your secure server (Cloudflare Worker). No tokens, repo names or PINs live in this file.
const API_BASE = "https://pdp.anmolvirk1997.workers.dev";
// -----------------------------------------------

let DATA_FILE = "data.json";   // PROFILES: set at login (default profile keeps data.json)

const defaultDuties = [
    "Anchoring", "Prayer", "Pledge", "Gayatri Mantra", "Mul Mantra",
    "Thought & Importance of the day", "Self Introduction", "Summary",
    "Speech", "GK Questions", "Poem", "Story", "Description", "Mastering the concept"
];

const defaultStudents = [
    { id: 1, name: "Aarav Sharma", class: "Class 6R" },
    { id: 2, name: "Ananya Verma", class: "Class 6R" },
    { id: 3, name: "Rohan Gupta", class: "Class 6R" },
    { id: 4, name: "Priya Singh", class: "Class 6R" },
    { id: 5, name: "Kabir Mehta", class: "Class 6R" },
    { id: 6, name: "Diya Patel", class: "Class 6R" },
    { id: 7, name: "Arjun Nair", class: "Class 6R" },
    { id: 8, name: "Sneha Rao", class: "Class 6R" },
    { id: 9, name: "Vikram Malhotra", class: "Class 6R" },
    { id: 10, name: "Neha Joshi", class: "Class 6R" },
    { id: 11, name: "Aditya Verma", class: "Class 6R" },
    { id: 12, name: "Kavya Iyer", class: "Class 6R" },
    { id: 13, name: "Devansh Kumar", class: "Class 6R" },
    { id: 14, name: "Riya Sen", class: "Class 6R" },
    { id: 15, name: "Tanvi Deshmukh", class: "Class 6R" }
];

/* ================= IDs =================
   Every student and every duty has a permanent ID. The schedule, absences
   and scores store IDs - never names or list positions - so renaming,
   reordering or deleting can never break the history. Names are looked up
   from the ID whenever something is shown on screen. */
const SCHEMA_VERSION = 2;
function newId(prefix) {
    return prefix + '_' + Date.now().toString(36) + Math.random().toString(36).slice(2, 8);
}
function uniqueId(prefix, taken) {
    let id;
    do { id = newId(prefix); } while (taken && taken.has(id));
    return id;
}
function makeDefaultDuties() { return defaultDuties.map(n => ({ id: newId('d'), name: n })); }
function makeDefaultStudents() { return defaultStudents.map(st => ({ id: newId('s'), name: st.name, class: st.class })); }

let appData = {
    schemaVersion: SCHEMA_VERSION,
    duties: makeDefaultDuties(),      // [{ id, name }]
    students: makeDefaultStudents(),  // [{ id, name, class }]
    formerStudents: [],               // people in old history who are not on the roster (kept so old records still show a name)
    assignments: {},     // mKey -> dutyId -> day -> [studentId]
    absences: {},        // mKey -> dutyId -> day -> [studentId]   (absent / did not perform)
    ratings: {},         // mKey -> dutyId -> day -> { studentId: { score, remark } }
    holidays: [],        // ["YYYY-MM-DD", ...]
    updatedAt: 0
};
let lastMigrationReport = null;   // set when old (name-based) data was just upgraded

// Look-ups (roster first, then former students)
function getStudent(id) {
    return appData.students.find(st => st.id === id) || (appData.formerStudents || []).find(st => st.id === id) || null;
}
function studentName(id) { const st = getStudent(id); return st ? st.name : '(unknown student)'; }
function getDuty(id) { return appData.duties.find(d => d.id === id) || null; }
function getOrCreateFormerStudent(name) {
    if (!appData.formerStudents) appData.formerStudents = [];
    const k = nameKey(name);
    let f = appData.formerStudents.find(st => nameKey(st.name) === k);
    if (!f) {
        f = { id: newId('s'), name: String(name).replace(/\s+/g, ' ').trim(), class: 'former student' };
        appData.formerStudents.push(f);
    }
    return f;
}

// Undo stack for clear duties / cell edit / import operations
let lastStateBackup = null;

const today = new Date();
let currentYear = today.getFullYear();
let currentMonth = today.getMonth();

let currentEditingCell = { year: currentYear, month: currentMonth, day: 1, dutyIdx: 0 };
let currentZoom = 1;

let cleanViewSelectedWeekdays = [1, 2, 3, 4, 5, 6]; // Mon=1 ... Sat=6
let cleanViewControlsVisible = true;

// Temporary state for cell modal so Cancel actually works
let modalTempAssignments = [];
let modalTempMeta = []; // parallel to modalTempAssignments: { score, remark, absent }

// Cloud sync state
let cloudSha = null;
let loadedUpdatedAt = 0;
let saveTimer = null;
let needsNameFixSave = false; // set when the name-mismatch fix changed data and it must be saved

/* ================= SMALL HELPERS ================= */

// Turns typed text into safe text so names can never break the page.
function esc(s) {
    return String(s ?? '').replace(/[&<>"']/g, c =>
        ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
}

// GitHub stores file contents in base64 - these two handle that.
function b64encode(str) {
    const bytes = new TextEncoder().encode(str);
    let bin = '';
    bytes.forEach(b => bin += String.fromCharCode(b));
    return btoa(bin);
}
function b64decode(str) {
    const bin = atob(str.replace(/\n/g, ''));
    const bytes = Uint8Array.from(bin, c => c.charCodeAt(0));
    return new TextDecoder('utf-8').decode(bytes);
}

function setSyncUI(msg) {
    const t = document.getElementById('syncStatusText');
    const badge = document.getElementById('saveBadge');
    if (t) t.textContent = msg;
    if (badge) badge.textContent = msg;
}

function saveLocal() {
    try { localStorage.setItem(localKey(), JSON.stringify(appData)); } catch (e) {}
}

/* ================= GITHUB CLOUD SYNC ================= */

function dataFileUrl() { return ghUrl(DATA_FILE); }
function githubHeaders() { return sessionToken ? { "Authorization": "Bearer " + sessionToken } : {}; }

// Reads data.json from your repo. Returns {json, sha} or null if it doesn't exist yet.
async function fetchDataFile() {
    const res = await fetch(dataFileUrl(), { headers: githubHeaders() });
    if (res.status === 404) return null; // file not created yet - first save will create it
    if (!res.ok) throw new Error("Could not read data file (status " + res.status + ")");
    const meta = await res.json();
    return { json: JSON.parse(b64decode(meta.content)), sha: meta.sha };
}

// Before the one-time ID upgrade: keep a permanent copy of the old data in the repo (never overwritten)
async function backupBeforeIds(obj) {
    try {
        const path = 'backups/' + DATA_FILE.replace(/\//g, '_') + '.pre-ids.json';
        const res = await fetch(ghUrl(path), { headers: githubHeaders(), cache: 'no-store' });
        if (res.status !== 404) return;                  // already backed up (or could not check) - never overwrite
        await putJsonFile(path, obj, 'Backup before ID upgrade');
    } catch (e) { console.warn('Pre-upgrade backup failed:', e); }
}

// Load: show local copy immediately, then bring in cloud data in the background.
async function loadFromGitHub() {
    const saved = localStorage.getItem(localKey());
    if (saved) { try { appData = JSON.parse(saved); } catch (e) {} }

    setSyncUI("Connecting...");
    try {
        const file = await fetchDataFile();
        if (file && file.json && file.json.duties) {
            if ((file.json.schemaVersion || 1) < SCHEMA_VERSION) await backupBeforeIds(file.json);
            appData = file.json;
            // Keep an untouched copy of the cloud data before any name fixing
            try { localStorage.setItem(backupKey(), JSON.stringify(appData)); } catch (e) {}
            if (normalizeAppData()) needsNameFixSave = true;
            cloudSha = file.sha;
            loadedUpdatedAt = appData.updatedAt || 0;
            saveLocal();
            setSyncUI("GitHub connected");
        } else {
            setSyncUI("No cloud data yet");
        }
        const sub = document.getElementById('syncSubText');
        if (sub) sub.textContent = "Secure cloud";
    } catch (err) {
        console.error("Cloud load failed, using local copy:", err);
        setSyncUI("Offline mode (local copy)");
    }
}

// Called after every change: saves instantly on this device, and waits
// 1.5 seconds of "quiet time" before sending everything to GitHub once.
function saveToStorage() {
    sgMarkActivity();                      // a change being saved counts as activity (session guard)
    savePending = true;
    saveLocal();
    setSyncUI("Saving...");
    clearTimeout(saveTimer);
    saveTimer = setTimeout(pushToGitHub, 1500);
}

async function pushToGitHub() {
    sgMarkActivity();                      // syncing counts as activity (session guard)
    savePending = false;
    setSyncUI("Syncing to GitHub...");
    try {
        // Read the current cloud copy first - needed for the version check and the file version id
        const current = await fetchDataFile().catch(() => null);

        // VERSIONING: if the cloud copy is NEWER than what we loaded, ask before overwriting
        if (current && current.json && typeof current.json.updatedAt === "number"
            && current.json.updatedAt > loadedUpdatedAt
            && JSON.stringify(current.json) !== JSON.stringify(appData)) {
            const overwrite = confirm("The cloud copy has NEWER changes than yours (maybe edited on another device).\n\nOK = overwrite the cloud with YOUR changes\nCancel = discard yours and load the cloud copy");
            if (!overwrite) {
                appData = current.json;
                normalizeAppData();
                cloudSha = current.sha;
                loadedUpdatedAt = appData.updatedAt || 0;
                saveLocal();
                renderPlanner();
                setSyncUI("Loaded cloud version");
                return;
            }
        }

        appData.updatedAt = Date.now();
        const body = {
            message: "Update duty planner data",
            content: b64encode(JSON.stringify(appData)),
        };
        if (current && current.sha) body.sha = current.sha;

        const res = await fetch(dataFileUrl(), {
            method: "PUT",
            headers: Object.assign(githubHeaders(), { "Content-Type": "application/json" }),
            body: JSON.stringify(body)
        });
        if (!res.ok) throw new Error("Save failed (status " + res.status + ")");
        const out = await res.json();
        cloudSha = out.content.sha;
        loadedUpdatedAt = appData.updatedAt;
        saveLocal();
        setSyncUI("Synced to GitHub");
        setTimeout(() => setSyncUI("All changes saved"), 2000);
    } catch (err) {
        console.error("Cloud save failed:", err);
        setSyncUI("Saved locally (will retry on next change)");
    }
}

/* ================= UI: SIDEBAR & TABS ================= */

// FIX: The sidebar now works the same on EVERY screen size.
// There is always a way to open it (hamburger) and close it (cross),
// including tablets/laptops in landscape. On wide screens the main
// content slides right instead of hiding under the menu.
let sidebarOpen = false;

function applySidebarState() {
    const sidebar = document.getElementById('sidebar');
    const backdrop = document.getElementById('sidebarBackdrop');
    const main = document.querySelector('main');
    if (!sidebar) return;

    if (sidebarOpen) {
        sidebar.classList.remove('-translate-x-full');
        // On wide screens, push the content right so the menu doesn't cover it
        if (main) main.classList.add('lg:pl-72');
        // Dark backdrop is only needed on small screens (menu floats over content there)
        if (backdrop) {
            if (window.innerWidth < 1024) backdrop.classList.remove('hidden');
            else backdrop.classList.add('hidden');
        }
    } else {
        sidebar.classList.add('-translate-x-full');
        if (main) main.classList.remove('lg:pl-72');
        if (backdrop) backdrop.classList.add('hidden');
    }
}

function toggleSidebar() {
    sidebarOpen = !sidebarOpen;
    applySidebarState();
}

// Keep everything correct if the user rotates the device or resizes the window
window.addEventListener('resize', applySidebarState);

function switchTab(tabId) {
    document.querySelectorAll('.tab-content').forEach(el => el.classList.add('hidden'));

    document.querySelectorAll('.nav-btn').forEach(btn => {
        btn.classList.remove('bg-brand-500', 'text-white', 'shadow-sm');
        btn.classList.add('text-gray-300', 'hover:bg-gray-800', 'hover:text-white');
    });

    const targetTab = document.getElementById(`tab-${tabId}`);
    if (targetTab) targetTab.classList.remove('hidden');

    const targetBtn = document.querySelector(`.nav-btn[data-tab="${tabId}"]`);
    if (targetBtn) {
        targetBtn.classList.remove('text-gray-300', 'hover:bg-gray-800', 'hover:text-white');
        targetBtn.classList.add('bg-brand-500', 'text-white', 'shadow-sm');
    }

    // Auto-close the sidebar after picking a tab on small screens
    if (sidebarOpen && window.innerWidth < 1024) {
        sidebarOpen = false;
        applySidebarState();
    }

    if (tabId === 'planner') renderPlanner();
    else if (tabId === 'students') renderStudentsTab();
    else if (tabId === 'duties') renderDutiesTab();
    else if (tabId === 'studentsview') renderStudentsView();
    else if (tabId === 'insights') renderInsights();
    else if (tabId === 'importExport') initExportControls();
}

/* ================= DATE / MONTH HELPERS ================= */

function getWorkingDaysForMonth(year, month) {
    let daysList = [];
    let date = new Date(year, month, 1);
    while (date.getMonth() === month) {
        if (date.getDay() !== 0) daysList.push(new Date(date));
        date.setDate(date.getDate() + 1);
    }
    return daysList;
}

function getWeeksForMonth(year, month) {
    const workingDays = getWorkingDaysForMonth(year, month);
    let weeks = [];
    let currentWeek = [];
    workingDays.forEach((dObj, idx) => {
        currentWeek.push(dObj);
        if (dObj.getDay() === 6 || idx === workingDays.length - 1) {
            weeks.push([...currentWeek]);
            currentWeek = [];
        }
    });
    return weeks;
}

function getMonthKey(year, month) {
    return `${year}-${String(month + 1).padStart(2, '0')}`;
}

function ensureMonthAssignments(year, month) {
    const mKey = getMonthKey(year, month);
    if (!appData.assignments) appData.assignments = {};

    // FIX: Months always start EMPTY. The app no longer invents any schedule -
    // students appear only in slots the teacher fills by hand. We only make
    // sure the month's container exists so saving works smoothly.
    if (!appData.assignments[mKey]) {
        appData.assignments[mKey] = {};
    }
}

/* Older saves (or the very first save) may not have the newer fields -
   fill them in so the rest of the app can rely on them existing. */
function normalizeAppData() {
    if (!appData.assignments) appData.assignments = {};
    if (!appData.absences) appData.absences = {};
    if (!appData.ratings) appData.ratings = {};
    if (!appData.holidays) appData.holidays = [];
    if (!appData.workingOverrides) appData.workingOverrides = []; // 2nd Saturdays the teacher marked as WORKING days

    if ((appData.schemaVersion || 1) < SCHEMA_VERSION) {
        // Keep an untouched copy on this device before the one-time upgrade
        try {
            const bk = localKey() + '_pre_ids';
            if (!localStorage.getItem(bk)) localStorage.setItem(bk, JSON.stringify(appData));
        } catch (e) {}
        lastMigrationReport = migrateToIds();
        return true;
    }
    return tidyIdData();
}

// Light clean-up for data that is already ID-based
function tidyIdData() {
    let changed = false;
    if (!Array.isArray(appData.formerStudents)) { appData.formerStudents = []; changed = true; }
    const clean = (o) => { const t = String(o.name == null ? '' : o.name).replace(/\s+/g, ' ').trim(); if (t !== o.name) { o.name = t; changed = true; } };
    appData.students.forEach(st => {
        clean(st);
        const c = String(st.class == null ? '' : st.class).trim();
        if (c !== st.class) { st.class = c; changed = true; }
        if (!st.id) { st.id = newId('s'); changed = true; }
    });
    appData.duties.forEach(d => { clean(d); if (!d.id) { d.id = newId('d'); changed = true; } });
    return changed;
}

/* ---- ONE-TIME UPGRADE: names / list positions  ->  permanent IDs ----
   1) the old name tidy-up runs first (spaces, capitals, known spelling fixes)
   2) every duty and student gets an ID
   3) the schedule, absences and scores are rewritten with IDs
   Names in the old schedule that are not on the Students list are kept as
   "former students" - nothing is ever thrown away. */
function migrateToIds() {
    const report = { unmatchedNames: [], duplicateNames: [], orphanDutyRows: 0 };
    if (!Array.isArray(appData.students)) appData.students = [];
    if (!Array.isArray(appData.duties)) appData.duties = [];

    fixNameMismatches();                                  // legacy tidy, works on the old name-based layout

    // duties -> { id, name }   (old position -> new id)
    const dutyIds = [];
    const dTaken = new Set();
    appData.duties = appData.duties.map(d => {
        const name = String(typeof d === 'string' ? d : (d && d.name) || '').replace(/\s+/g, ' ').trim() || 'Duty';
        const id = (d && typeof d === 'object' && d.id) ? String(d.id) : uniqueId('d', dTaken);
        dTaken.add(id);
        dutyIds.push(id);
        return { id, name };
    });

    // students -> permanent string ids
    const sTaken = new Set();
    const byKey = {};
    appData.students = appData.students.map(st => {
        const id = uniqueId('s', sTaken);
        sTaken.add(id);
        const k = nameKey(st.name);
        if (byKey[k] === undefined) byKey[k] = id; else report.duplicateNames.push(st.name);
        return { id, name: st.name, class: st.class };
    });
    appData.formerStudents = [];
    const toId = (name) => {
        const k = nameKey(name);
        if (byKey[k] !== undefined) return byKey[k];
        const before = appData.formerStudents.length;
        const f = getOrCreateFormerStudent(name);
        if (appData.formerStudents.length > before) report.unmatchedNames.push(f.name);
        return f.id;
    };

    const convertField = (field, convertDay) => {
        const src = appData[field] || {};
        const out = {};
        Object.keys(src).forEach(mk => {
            const m = src[mk] || {};
            const nm = {};
            Object.keys(m).forEach(di => {
                const dutyId = dutyIds[parseInt(di, 10)];
                const days = m[di] || {};
                if (dutyId === undefined) { if (Object.keys(days).length) report.orphanDutyRows++; return; }
                const nd = {};
                Object.keys(days).forEach(day => { nd[day] = convertDay(days[day]); });
                nm[dutyId] = nd;
            });
            out[mk] = nm;
        });
        appData[field] = out;
    };
    const idList = (list) => {
        const out = [];
        (Array.isArray(list) ? list : []).forEach(n => { if (!n) return; const id = toId(n); if (!out.includes(id)) out.push(id); });
        return out;
    };
    convertField('assignments', idList);
    convertField('absences', idList);
    convertField('ratings', (o) => {
        const out = {};
        Object.keys(o || {}).forEach(n => { const id = toId(n); if (out[id] === undefined) out[id] = o[n]; });
        return out;
    });

    appData.schemaVersion = SCHEMA_VERSION;
    if (report.unmatchedNames.length || report.duplicateNames.length || report.orphanDutyRows) console.warn('ID upgrade notes:', report);
    return report;
}

function announceMigration(r) {
    if (!r || !(r.unmatchedNames.length || r.duplicateNames.length || r.orphanDutyRows)) return;
    let msg = 'Your data was upgraded to the new ID system (a backup copy was saved first).\n';
    if (r.unmatchedNames.length) msg += '\n- ' + r.unmatchedNames.length + ' name(s) in the old schedule are not on your Students list. They are kept as "former students" so the history still shows them: ' + r.unmatchedNames.join(', ') + '.';
    if (r.duplicateNames.length) msg += '\n- Two students share the name: ' + r.duplicateNames.join(', ') + '. Old records for that name were linked to the first one.';
    if (r.orphanDutyRows) msg += '\n- ' + r.orphanDutyRows + ' old schedule row(s) belonged to duties that no longer exist and were not carried over (they remain in the backup).';
    alert(msg);
}

/* ---- NAME MISMATCH FIX (legacy - only used once, inside the ID upgrade) ----
   Students are linked to the schedule by NAME. If the student list says
   "Nidhi " (trailing space) but the schedule says "Nidhi", the Students
   view / Insights treat them as two different people. This function makes
   every name in the schedule match the student list.
   SAFE: it only RENAMES. Nothing is deleted. Names it cannot match are left
   exactly as they are. Runs every load but changes nothing once data is clean. */

// Spaces/case-insensitive comparison key
function nameKey(s) { return String(s == null ? '' : s).replace(/\s+/g, ' ').trim().toLowerCase(); }

// One-time spelling/short-name corrections (old schedule name -> student-list name).
// Only used when the target student really exists in the list.
const NAME_ALIASES = { 'asdeep': 'Ashdeep', 'hargun': 'Hargunpreet' };

function fixNameMismatches() {
    let changed = false;

    // 1) tidy the student list and duty names (remove stray spaces)
    appData.students.forEach(s => {
        const t = String(s.name).replace(/\s+/g, ' ').trim();
        if (t !== s.name) { s.name = t; changed = true; }
        const c = String(s.class == null ? '' : s.class).trim();
        if (c !== s.class) { s.class = c; changed = true; }
    });
    appData.duties = appData.duties.map(d => {
        if (typeof d !== 'string') return d;              // already an { id, name } object - leave it alone
        const t = d.replace(/\s+/g, ' ').trim();
        if (t !== d) changed = true;
        return t;
    });

    // 2) work out which roster name each schedule name should become
    const byKey = {};
    appData.students.forEach(s => { byKey[nameKey(s.name)] = s.name; });
    const canon = (n) => {
        if (byKey[nameKey(n)] !== undefined) return byKey[nameKey(n)];
        const alias = NAME_ALIASES[nameKey(n)];
        if (alias && byKey[nameKey(alias)] !== undefined) return byKey[nameKey(alias)];
        return n; // unknown name: leave untouched, never lose data
    };

    const fixList = (list) => {
        if (!Array.isArray(list)) return list;
        const out = [];
        list.forEach(n => { const c = canon(n); if (c !== n) changed = true; if (!out.includes(c)) out.push(c); });
        if (out.length !== list.length) changed = true;
        return out;
    };

    ['assignments', 'absences'].forEach(field => {
        Object.keys(appData[field] || {}).forEach(mk => {
            const m = appData[field][mk] || {};
            Object.keys(m).forEach(di => {
                const days = m[di] || {};
                Object.keys(days).forEach(day => { days[day] = fixList(days[day]); });
            });
        });
    });
    Object.keys(appData.ratings || {}).forEach(mk => {
        const m = appData.ratings[mk] || {};
        Object.keys(m).forEach(di => {
            const days = m[di] || {};
            Object.keys(days).forEach(day => {
                const o = days[day] || {};
                const fixed = {};
                Object.keys(o).forEach(n => {
                    const c = canon(n);
                    if (c !== n) changed = true;
                    if (fixed[c] === undefined) fixed[c] = o[n]; // never overwrite an existing score
                });
                days[day] = fixed;
            });
        });
    });
    return changed;
}

/* ---- Holidays ---- */
function isoOf(y, m, d) {
    return `${y}-${String(m + 1).padStart(2, '0')}-${String(d).padStart(2, '0')}`;
}
// 2nd Saturday of a month = a Saturday falling on the 8th-14th
function isSecondSaturday(y, m, d) {
    return new Date(y, m, d).getDay() === 6 && d >= 8 && d <= 14;
}
// A day is a holiday if it was marked by hand, or it is a 2nd Saturday
// (unless the teacher switched that particular 2nd Saturday back to a working day).
function isHolidayDate(y, m, d) {
    const iso = isoOf(y, m, d);
    if ((appData.workingOverrides || []).includes(iso)) return false;
    return (appData.holidays || []).includes(iso) || isSecondSaturday(y, m, d);
}

/* ---- Complete-week grid: pad the planner with the days of the previous
   and next month so every visible week runs Monday-Saturday (Sundays are
   never shown). Padded days are dimmed and read-only. ---- */
function getPaddedWorkingDays(year, month) {
    const days = getWorkingDaysForMonth(year, month);
    if (!days.length) return days;
    const padded = [];
    const first = days[0];
    const leadCount = first.getDay() - 1; // Mon=1 ... Sat=6 -> days to add before
    for (let i = leadCount; i > 0; i--) {
        padded.push(new Date(year, month, 1 - i));
    }
    padded.push(...days);
    const last = days[days.length - 1];
    if (last.getDay() !== 6) {
        let d = new Date(last);
        d.setDate(d.getDate() + 1);
        while (d.getDay() !== 0) { // stop after Saturday
            padded.push(new Date(d));
            d.setDate(d.getDate() + 1);
        }
    }
    return padded;
}

/* The same padded grid, cut into full Mon-Sat weeks (6 days each).
   Used by Clean View so its weeks match the planner exactly. */
function getPaddedWeeksForMonth(year, month) {
    const days = getPaddedWorkingDays(year, month);
    const weeks = [];
    for (let i = 0; i < days.length; i += 6) weeks.push(days.slice(i, i + 6));
    return weeks;
}

/* Short label for a week: "5-10" or, when it crosses months, "28 Sep - 3 Oct" */
function weekRangeLabel(wk) {
    const sm = ["Jan","Feb","Mar","Apr","May","Jun","Jul","Aug","Sep","Oct","Nov","Dec"];
    const f = wk[0], l = wk[wk.length - 1];
    return f.getMonth() === l.getMonth()
        ? `${f.getDate()}-${l.getDate()}`
        : `${f.getDate()} ${sm[f.getMonth()]} - ${l.getDate()} ${sm[l.getMonth()]}`;
}

/* First working day AFTER the given date (skips Sundays + holidays). */
function nextWorkingDayAfter(y, m, d) {
    let t = new Date(y, m, d + 1);
    let guard = 0;
    while ((t.getDay() === 0 || isHolidayDate(t.getFullYear(), t.getMonth(), t.getDate())) && guard < 62) {
        t.setDate(t.getDate() + 1);
        guard++;
    }
    return t;
}

function changeMonth(direction) {
    currentMonth += direction;
    if (currentMonth > 11) { currentMonth = 0; currentYear++; }
    else if (currentMonth < 0) { currentMonth = 11; currentYear--; }
    renderPlanner();
}

/* ================= PLANNER GRID ================= */

function renderPlanner() {
    ensureMonthAssignments(currentYear, currentMonth);

    const monthNames = ["January", "February", "March", "April", "May", "June", "July", "August", "September", "October", "November", "December"];
    const shortMonths = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];
    document.getElementById('monthYearLabel').textContent = `${monthNames[currentMonth]} ${currentYear}`;

    // Full Mon-Sat weeks, padded with previous/next month days
    const gridDays = getPaddedWorkingDays(currentYear, currentMonth);
    const monthStart = new Date(currentYear, currentMonth, 1);
    const isInMonth = dObj => dObj.getMonth() === currentMonth && dObj.getFullYear() === currentYear;

    // Padded ("borrowed") days are full, normal days - they just carry a subtle marker:
    // a small "Prev/Next month" tag in the header, and a dotted line where the month starts/ends.
    const padClass = (i) => {
        const dObj = gridDays[i];
        if (isInMonth(dObj)) return '';
        let c = ' pad-day';
        const nextD = gridDays[i + 1], prevD = gridDays[i - 1];
        if (nextD && isInMonth(nextD)) c += ' pad-edge-r';   // last borrowed day before the month starts
        if (prevD && isInMonth(prevD)) c += ' pad-edge-l';   // first borrowed day after the month ends
        return c;
    };

    const headerRow = document.getElementById('tableHeaderRow');
    let headerHTML = `<th class="p-4 font-bold frozen-header bg-brand-100/90 border-r border-gray-200 w-64 shadow-sm">DUTY / DATE</th>`;
    gridDays.forEach((dObj, i) => {
        const inMonth = isInMonth(dObj);
        const holiday = isHolidayDate(dObj.getFullYear(), dObj.getMonth(), dObj.getDate());
        const dayNameShort = dObj.toLocaleDateString('en-US', { weekday: 'short' });
        const dateNum = dObj.getDate();
        let cls = 'p-4 font-semibold text-center min-w-[150px] border-r border-gray-200' + padClass(i);
        let extra = '';
        let dateCls = 'text-xs font-bold ' + (inMonth ? 'text-brand-600' : 'text-slate-600');
        if (!inMonth) {
            const isPrev = dObj < monthStart;
            extra += `<br><span class="inline-block mt-1 px-1.5 py-px rounded-full bg-slate-200 text-slate-600 text-[8px] font-bold tracking-wider uppercase">${isPrev ? 'Prev month' : 'Next month'}</span>`;
        }
        if (holiday) {
            cls += ' bg-red-100 text-red-700';
            dateCls = 'text-xs font-bold text-red-600 line-through';
            extra += `<br><span class="text-[9px] font-bold tracking-widest text-red-500">HOLIDAY</span>`;
        }
        headerHTML += `<th class="${cls}">${dayNameShort}<br><span class="${dateCls}">${dateNum} ${shortMonths[dObj.getMonth()]}</span>${extra}</th>`;
    });
    headerRow.innerHTML = headerHTML;

    const tbody = document.getElementById('tableBody');
    let bodyHTML = '';

    appData.duties.forEach((duty, dIdx) => {
        bodyHTML += `<tr class="hover:bg-gray-50/85 transition">`;
        bodyHTML += `<td class="p-4 font-semibold text-gray-800 frozen-col border-r border-gray-200 shadow-sm bg-white">${esc(duty.name)}</td>`;

        gridDays.forEach((dObj, i) => {
            // Every day uses ITS OWN month's data, so borrowed days show what is really assigned to them
            const y = dObj.getFullYear(), m = dObj.getMonth(), dayNum = dObj.getDate();
            const cellKey = getMonthKey(y, m);
            const pad = padClass(i);

            // Holidays: red, read-only (duties get shifted via the Holidays tool)
            if (isHolidayDate(y, m, dayNum)) {
                bodyHTML += `<td class="p-3 border-r border-gray-200 bg-red-50/60${pad}"></td>`;
                return;
            }

            const assignedList = (appData.assignments[cellKey] &&
                                  appData.assignments[cellKey][duty.id] &&
                                  appData.assignments[cellKey][duty.id][dayNum]) || [];
            const absentList = (((appData.absences || {})[cellKey] || {})[duty.id] || {})[dayNum] || [];

            let studentTagsHTML = '';
            if (assignedList.length === 0) {
                studentTagsHTML = `<span class="text-xs text-gray-400 italic">Unassigned</span>`;
            } else {
                assignedList.forEach(studentId => {
                    const sName = studentName(studentId);
                    const isAbsent = absentList.includes(studentId);
                    if (isAbsent) {
                        studentTagsHTML += `
                            <div class="inline-flex items-center bg-red-50 border border-red-200 text-red-600 px-2.5 py-1 rounded-lg text-xs font-medium my-0.5 mr-1 shadow-sm" title="Absent / did not perform">
                                <i class="fa-solid fa-user-xmark mr-1.5 text-[10px]"></i><span class="line-through">${esc(sName)}</span>
                            </div>`;
                        return;
                    }
                    const isRed = checkMultipleDutiesSameDay(cellKey, dayNum, studentId);
                    const isYellow = checkRepeatedWithin10Days(duty.id, y, m, dayNum, studentId);

                    let indicatorDot = '';
                    if (isRed) indicatorDot = `<span class="w-2 h-2 rounded-full bg-red-500 inline-block ml-1.5 shadow-sm" title="Assigned 2+ duties on this day"></span>`;
                    else if (isYellow) indicatorDot = `<span class="w-2 h-2 rounded-full bg-amber-400 inline-block ml-1.5 shadow-sm" title="Repeated duty in recent rotation"></span>`;

                    studentTagsHTML += `
                        <div class="inline-flex items-center bg-brand-50 border border-brand-100 text-brand-900 px-2.5 py-1 rounded-lg text-xs font-medium my-0.5 mr-1 shadow-sm">
                            <span>${esc(sName)}</span>
                            ${indicatorDot}
                        </div>
                    `;
                });
            }

            bodyHTML += `
                <td class="p-3 border-r border-gray-200 cursor-pointer hover:bg-brand-50/40 transition align-top${pad}" onclick="openCellModal(${y}, ${m}, ${dayNum}, ${dIdx})">
                    <div class="flex flex-wrap items-center min-h-[40px]">${studentTagsHTML}</div>
                </td>
            `;
        });
        bodyHTML += `</tr>`;
    });
    tbody.innerHTML = bodyHTML;
}

// A student marked "Not performed" did not actually have that duty on that day.
// Those records never count towards the red / yellow dots, the editor's counters, or smart suggestions.
function wasAbsent(mKey, dutyId, day, studentId) {
    const list = ((((appData.absences || {})[mKey] || {})[dutyId]) || {})[day];
    return !!(list && list.includes(studentId));
}

function checkMultipleDutiesSameDay(mKey, dayNum, studentId) {
    let count = 0;
    appData.duties.forEach(duty => {
        const list = (appData.assignments[mKey] && appData.assignments[mKey][duty.id] && appData.assignments[mKey][duty.id][dayNum]) || [];
        if (list.includes(studentId) && !wasAbsent(mKey, duty.id, dayNum, studentId)) count++;
    });
    return count >= 2;
}

// Was this student on the same duty within the previous 10 working days? Works for ANY date
// (including days borrowed from the previous / next month), based on that date's own month.
function checkRepeatedWithin10Days(dutyId, year, month, dayNum, studentId) {
    let prevYear = year;
    let prevMonth = month - 1;
    if (prevMonth < 0) { prevMonth = 11; prevYear--; }

    const prevWorkingDays = getWorkingDaysForMonth(prevYear, prevMonth);
    const currWorkingDays = getWorkingDaysForMonth(year, month);
    const allWorkingDays = [...prevWorkingDays, ...currWorkingDays];

    const currentFlatIndex = allWorkingDays.findIndex(dObj =>
        dObj.getDate() === dayNum &&
        dObj.getMonth() === month &&
        dObj.getFullYear() === year
    );
    if (currentFlatIndex === -1) return false;

    let matchCount = 0;
    const start = Math.max(0, currentFlatIndex - 9);
    for (let i = start; i <= currentFlatIndex; i++) {
        const dObj = allWorkingDays[i];
        const checkMKey = getMonthKey(dObj.getFullYear(), dObj.getMonth());
        const list = (appData.assignments[checkMKey] && appData.assignments[checkMKey][dutyId] && appData.assignments[checkMKey][dutyId][dObj.getDate()]) || [];
        if (list.includes(studentId) && !wasAbsent(checkMKey, dutyId, dObj.getDate(), studentId)) matchCount++;
    }
    return matchCount > 1;
}

/* ================= CELL EDIT MODAL =================
   Each slot: student picker + smart-suggest + score (1-5) + optional remark
   + absent toggle. Names go to assignments; scores/remarks go to ratings;
   absent flags go to absences. */

function openCellModal(year, month, dayNum, dutyIdx) {
    const duty = appData.duties[dutyIdx];
    if (!duty) return;
    hideUndoToast();   // never let the toast sit over the editor
    currentEditingCell = { year, month, day: dayNum, dutyIdx, dutyId: duty.id };
    const dutyName = duty.name;
    const dObj = new Date(year, month, dayNum);
    const dateStr = dObj.toLocaleDateString('en-US', { weekday: 'long', month: 'long', day: 'numeric', year: 'numeric' });

    document.getElementById('modalDutyTitle').textContent = dutyName;
    document.getElementById('modalDaySubtitle').textContent = dateStr;

    const mKey = getMonthKey(year, month);
    const existing = (appData.assignments[mKey] && appData.assignments[mKey][duty.id] && appData.assignments[mKey][duty.id][dayNum]) || [];
    modalTempAssignments = JSON.parse(JSON.stringify(existing));

    // Restore any previously saved score / remark / absent flag per slot
    const ratingCell = ((appData.ratings[mKey] || {})[duty.id] || {})[dayNum] || {};
    const absentList = ((appData.absences[mKey] || {})[duty.id] || {})[dayNum] || [];
    modalTempMeta = existing.map(sid => {
        const r = ratingCell[sid];
        return { score: r ? r.score : null, remark: r ? (r.remark || '') : '', absent: absentList.includes(sid) };
    });

    computeModalInfo();
    renderModalToolbar();
    renderModalGrid();
    renderModalSelected();
    document.getElementById('modalGridWrap').scrollTop = 0;
    document.getElementById('cellModal').classList.remove('hidden');
}

function cancelCellModal() {
    modalTempAssignments = [];
    modalTempMeta = [];
    document.getElementById('cellModal').classList.add('hidden');
    renderPlanner();
}

function closeCellModal() {
    modalTempAssignments = [];
    modalTempMeta = [];
    document.getElementById('cellModal').classList.add('hidden');
    renderPlanner();
    saveToStorage();
}

/* ================= ASSIGN-STUDENTS EDITOR (student grid) =================
   Tap a student to select / un-select them. Under each name:
     - a dot:  red = already has ANOTHER duty on this day
               yellow = had THIS duty within the last 10 working days (same window the planner uses)
               split red/yellow = both
     - a counter: how many times they had this duty in the last 1 / 2 / 3 months (your choice) */
let modalCountMonths = 3;
try { const v = parseInt(localStorage.getItem('pdp_modal_count_months'), 10); if (v === 1 || v === 2 || v === 3) modalCountMonths = v; } catch (e) {}
let modalInfo = { busy: new Set(), recent: new Set(), counts: {} };

// date minus n months, staying inside the target month (31 Mar - 1 month = 28/29 Feb)
function subtractMonths(date, n) {
    const d = new Date(date.getFullYear(), date.getMonth() - n, 1);
    const last = new Date(d.getFullYear(), d.getMonth() + 1, 0).getDate();
    d.setDate(Math.min(date.getDate(), last));
    return d;
}

// Students who already have a DIFFERENT duty on this day
function studentsBusyOtherDuties(dutyId, year, month, dayNum) {
    const out = new Set();
    const mKey = getMonthKey(year, month);
    appData.duties.forEach(d => {
        if (d.id === dutyId) return;
        ((((appData.assignments[mKey] || {})[d.id]) || {})[dayNum] || []).forEach(id => { if (!wasAbsent(mKey, d.id, dayNum, id)) out.add(id); });
    });
    return out;
}

// Students who had THIS duty in the 9 working days before this day (the planner flags a repeat inside a 10-working-day window that ends on the day itself)
function studentsWithDutyRecently(dutyId, year, month, dayNum) {
    const out = new Set();
    let prevYear = year, prevMonth = month - 1;
    if (prevMonth < 0) { prevMonth = 11; prevYear--; }
    const all = [...getWorkingDaysForMonth(prevYear, prevMonth), ...getWorkingDaysForMonth(year, month)];
    const idx = all.findIndex(d => d.getDate() === dayNum && d.getMonth() === month && d.getFullYear() === year);
    if (idx === -1) return out;
    for (let i = Math.max(0, idx - 9); i < idx; i++) {
        const d = all[i];
        const mk = getMonthKey(d.getFullYear(), d.getMonth());
        const list = (appData.assignments[mk] && appData.assignments[mk][dutyId] && appData.assignments[mk][dutyId][d.getDate()]) || [];
        list.forEach(id => { if (!wasAbsent(mk, dutyId, d.getDate(), id)) out.add(id); });
    }
    return out;
}

// How many times each student had THIS duty in the last N months (before this day; this day itself is not counted)
function countDutyInLastMonths(dutyId, year, month, dayNum, monthsBack) {
    const counts = {};
    const end = new Date(year, month, dayNum);
    const start = subtractMonths(end, monthsBack);
    const cursor = new Date(start.getFullYear(), start.getMonth(), 1);
    while (cursor <= end) {
        const y = cursor.getFullYear(), m = cursor.getMonth();
        const mk = getMonthKey(y, m);
        const daysMap = (((appData.assignments || {})[mk] || {})[dutyId]) || {};
        Object.keys(daysMap).forEach(dayStr => {
            const dt = new Date(y, m, parseInt(dayStr, 10));
            if (dt >= start && dt < end) (daysMap[dayStr] || []).forEach(id => {
                if (wasAbsent(mk, dutyId, dayStr, id)) return;
                counts[id] = (counts[id] || 0) + 1;
            });
        });
        cursor.setMonth(cursor.getMonth() + 1);
    }
    return counts;
}

function computeModalInfo() {
    const c = currentEditingCell;
    modalInfo = {
        busy: studentsBusyOtherDuties(c.dutyId, c.year, c.month, c.day),
        recent: studentsWithDutyRecently(c.dutyId, c.year, c.month, c.day),
        counts: countDutyInLastMonths(c.dutyId, c.year, c.month, c.day, modalCountMonths)
    };
}

function setModalCountMonths(n) {
    if (n !== 1 && n !== 2 && n !== 3) return;
    modalCountMonths = n;
    try { localStorage.setItem('pdp_modal_count_months', String(n)); } catch (e) {}
    const c = currentEditingCell;
    modalInfo.counts = countDutyInLastMonths(c.dutyId, c.year, c.month, c.day, modalCountMonths);
    renderModalToolbar();
    renderModalGrid();
}

function renderModalToolbar() {
    document.querySelectorAll('#modalMonthBtns button').forEach(b => {
        const on = parseInt(b.dataset.m, 10) === modalCountMonths;
        b.className = 'px-2.5 py-1 text-xs font-semibold transition' + (b.dataset.m === '1' ? '' : ' border-l border-gray-300') +
            (on ? ' bg-brand-500 text-white' : ' bg-white text-gray-600 hover:bg-gray-50');
        b.setAttribute('aria-pressed', on ? 'true' : 'false');
    });
}

function renderModalGrid() {
    const grid = document.getElementById('modalGrid');
    const wrap = document.getElementById('modalGridWrap');
    const keepScroll = wrap.scrollTop;
    if (!appData.students.length) {
        grid.innerHTML = '<div class="text-xs text-gray-500 italic p-2" style="grid-column: 1 / -1;">No students yet. Add students in the Students tab first.</div>';
        return;
    }
    const monthsLabel = modalCountMonths + ' mo';
    grid.innerHTML = appData.students.map((st, i) => {
        const selected = modalTempAssignments.includes(st.id);
        const busy = modalInfo.busy.has(st.id), recent = modalInfo.recent.has(st.id);
        const dot = busy && recent ? 'pd-dot-both' : busy ? 'pd-dot-red' : recent ? 'pd-dot-yellow' : 'pd-dot-none';
        const n = modalInfo.counts[st.id] || 0;
        const notes = [];
        if (busy) notes.push('has another duty this day');
        if (recent) notes.push('had this duty in the last 10 days');
        const tip = `${st.name}${st.class ? ' (' + st.class + ')' : ''}: ${notes.length ? notes.join(', ') + '; ' : ''}${n} time${n === 1 ? '' : 's'} in the last ${modalCountMonths} month${modalCountMonths === 1 ? '' : 's'}`;
        return `<button type="button" onclick="modalToggleStudent(${i})" aria-pressed="${selected}" title="${esc(tip)}" aria-label="${esc(tip)}" class="relative text-left p-2.5 pr-7 rounded-xl border transition min-h-[62px] flex flex-col justify-between ${selected ? 'bg-brand-50 border-brand-500 ring-2 ring-brand-500/40' : 'bg-white border-gray-200 hover:border-brand-500 hover:bg-brand-50/50'}">
            <span class="cm-name text-sm font-semibold text-gray-900 leading-tight">${esc(st.name)}</span>
            <span class="mt-1.5 flex items-center gap-1.5 text-[11px] text-gray-500"><i class="pd-dot ${dot}"></i><span><b class="text-gray-700">${n}&times;</b> in ${monthsLabel}</span></span>
            ${selected ? '<i class="fa-solid fa-circle-check text-brand-500 absolute top-2 right-2"></i>' : ''}
        </button>`;
    }).join('');
    wrap.scrollTop = keepScroll;
}

function renderModalSelected() {
    const list = document.getElementById('modalSelectedList');
    document.getElementById('modalSelectedCount').textContent = modalTempAssignments.length;
    if (modalTempAssignments.length === 0) {
        list.innerHTML = '<div class="text-xs text-gray-500 italic p-1" style="grid-column: 1 / -1;">No students selected yet. Tap a student above.</div>';
        return;
    }
    list.innerHTML = modalTempAssignments.map((studentId, idx) => {
        const meta = modalTempMeta[idx] || { score: null, remark: '', absent: false };
        const onRoster = appData.students.some(s => s.id === studentId);
        let scoreBtns = '';
        for (let n = 1; n <= 5; n++) {
            const on = meta.score === n;
            scoreBtns += `<button type="button" onclick="setScoreForSlot(${idx}, ${n})" ${meta.absent ? 'disabled' : ''} class="cm-score-btn rounded-md text-xs font-bold transition ${meta.absent ? 'opacity-40 cursor-not-allowed ' : ''}${on ? 'bg-brand-500 text-white shadow' : 'bg-white border border-gray-300 text-gray-500 hover:border-brand-500 hover:text-brand-600'}" title="Score ${n}/5">${n}</button>`;
        }
        return `
            <div class="min-w-0 p-2.5 rounded-xl border transition ${meta.absent ? 'bg-red-50/60 border-red-300' : 'bg-white border-gray-200'}">
                <div class="flex items-center justify-between gap-2">
                    <p class="min-w-0 text-sm font-bold text-gray-900 truncate" title="${esc(studentName(studentId))}">${esc(studentName(studentId))}${onRoster ? '' : ' <span class="text-[10px] font-semibold text-amber-600 ml-1">archived</span>'}</p>
                    <div class="flex items-center gap-1.5 shrink-0">
                        <button type="button" onclick="toggleAbsentForSlot(${idx})" class="cm-flag-btn whitespace-nowrap text-[10px] font-bold rounded-lg border transition ${meta.absent ? 'bg-red-500 text-white border-red-500' : 'bg-white text-red-500 border-red-200 hover:bg-red-50'}" title="Student was absent or did not perform" aria-pressed="${meta.absent ? 'true' : 'false'}">${meta.absent ? 'NOT PERFORMED' : 'Not performed'}</button>
                        <button type="button" onclick="removeStudentSlot(${idx})" class="cm-icon-btn flex items-center justify-center text-red-500 hover:bg-red-50 rounded-lg" aria-label="Remove student" title="Remove student from this duty"><i class="fa-solid fa-trash text-xs"></i></button>
                    </div>
                </div>
                <div class="flex flex-wrap items-center gap-2 mt-2">
                    <span class="hidden sm:inline text-[10px] text-gray-400 font-bold uppercase">Score</span>
                    <div class="flex items-center gap-1">${scoreBtns}</div>
                    <input type="text" value="${esc(meta.remark)}" oninput="setRemarkForSlot(${idx}, this.value)" placeholder="Remark (optional)" aria-label="Remark (optional)" class="flex-1 min-w-[90px] border border-gray-300 rounded-lg p-1.5 text-xs bg-white focus:outline-none focus:ring-2 focus:ring-brand-500">
                </div>
            </div>
        `;
    }).join('');
}

// Tap a student card: select them, or un-select if already selected
function modalToggleStudent(i) {
    const st = appData.students[i];
    if (!st) return;
    const at = modalTempAssignments.indexOf(st.id);
    if (at >= 0) {
        modalTempAssignments.splice(at, 1);
        modalTempMeta.splice(at, 1);
    } else {
        modalTempAssignments.push(st.id);
        modalTempMeta.push({ score: null, remark: '', absent: false });
    }
    renderModalGrid();
    renderModalSelected();
    if (at < 0) { const w = document.getElementById('modalSelectedWrap'); w.scrollTop = w.scrollHeight; }
}

// Smart suggest: add the least-used student for this duty who is not selected yet
function suggestAddStudent() {
    if (!appData.students.length) { alert("Add students in the Students tab first."); return; }
    const pick = pickBestStudent(currentEditingCell.dutyId, currentEditingCell.year, currentEditingCell.month, currentEditingCell.day, modalTempAssignments);
    if (!pick) { alert("Every student is already selected."); return; }
    const i = appData.students.findIndex(s => s.id === pick);
    modalToggleStudent(i);
    const card = document.getElementById('modalGrid').children[i];
    if (card && card.scrollIntoView) card.scrollIntoView({ block: 'nearest' });
}

function setScoreForSlot(idx, n) {
    if (!modalTempMeta[idx]) return;
    modalTempMeta[idx].score = (modalTempMeta[idx].score === n) ? null : n; // click again to clear
    renderModalSelected();
}
function setRemarkForSlot(idx, val) {
    if (modalTempMeta[idx]) modalTempMeta[idx].remark = val;
}
function toggleAbsentForSlot(idx) {
    if (!modalTempMeta[idx]) return;
    modalTempMeta[idx].absent = !modalTempMeta[idx].absent;
    renderModalSelected();
}
function removeStudentSlot(slotIdx) {
    modalTempAssignments.splice(slotIdx, 1);
    modalTempMeta.splice(slotIdx, 1);
    renderModalGrid();
    renderModalSelected();
}

/* Wand button: fill this slot with the most fair pick (see SMART ASSIGN section). */
function saveCellAssignments() {
    let entries = [];
    const seen = new Set();
    modalTempAssignments.forEach((sid, i) => {
        if (!sid || seen.has(sid)) return;
        seen.add(sid);
        entries.push({ id: sid, meta: modalTempMeta[i] || { score: null, remark: '', absent: false } });
    });

    const mKey = getMonthKey(currentEditingCell.year, currentEditingCell.month);
    const dKey = currentEditingCell.dutyId;
    const day = currentEditingCell.day;
    if (!appData.assignments[mKey]) appData.assignments[mKey] = {};
    if (!appData.assignments[mKey][dKey]) appData.assignments[mKey][dKey] = {};
    if (!appData.ratings[mKey]) appData.ratings[mKey] = {};
    if (!appData.ratings[mKey][dKey]) appData.ratings[mKey][dKey] = {};
    if (!appData.absences[mKey]) appData.absences[mKey] = {};
    if (!appData.absences[mKey][dKey]) appData.absences[mKey][dKey] = {};

    // Backup for undo
    lastStateBackup = JSON.parse(JSON.stringify(appData));
    appData.assignments[mKey][dKey][day] = entries.map(e => e.id);

    const ratingObj = {};
    const absentArr = [];
    entries.forEach(e => {
        if (e.meta.absent) absentArr.push(e.id);
        else if (e.meta.score) ratingObj[e.id] = { score: e.meta.score, remark: (e.meta.remark || '').trim() };
    });
    appData.ratings[mKey][dKey][day] = ratingObj;
    appData.absences[mKey][dKey][day] = absentArr;

    closeCellModal();
    showUndoToast('Assignments updated.');
}

/* ================= CLEAR DUTIES & UNDO ================= */

function openClearDutiesModal() {
    const weeks = getWeeksForMonth(currentYear, currentMonth);
    const weekSelect = document.getElementById('clearWeekSelect');
    let weekHtml = '';
    weeks.forEach((wk, wIdx) => {
        const firstDate = wk[0].getDate();
        const lastDate = wk[wk.length - 1].getDate();
        weekHtml += `<option value="${wIdx}">Week ${wIdx + 1} (${firstDate} - ${lastDate} ${["Jan","Feb","Mar","Apr","May","Jun","Jul","Aug","Sep","Oct","Nov","Dec"][currentMonth]})</option>`;
    });
    weekSelect.innerHTML = weekHtml;
    toggleClearWeekSelector();
    document.getElementById('clearDutiesModal').classList.remove('hidden');
}

function closeClearDutiesModal() {
    document.getElementById('clearDutiesModal').classList.add('hidden');
}

function toggleClearWeekSelector() {
    const scope = document.getElementById('clearScopeSelect').value;
    const weekWrapper = document.getElementById('clearWeekWrapper');
    if (scope === 'week') weekWrapper.classList.remove('hidden');
    else weekWrapper.classList.add('hidden');
}

function executeClearDuties() {
    const scope = document.getElementById('clearScopeSelect').value;
    const mKey = getMonthKey(currentYear, currentMonth);

    lastStateBackup = JSON.parse(JSON.stringify(appData));

    // Scores and absence marks belong to the same slots as the assignments,
    // so they are cleared together (otherwise old data keeps showing in Students view / Insights).
    const CLEAR_FIELDS = ['assignments', 'ratings', 'absences'];
    if (!appData.ratings) appData.ratings = {};
    if (!appData.absences) appData.absences = {};

    if (scope === 'week') {
        const wIdx = parseInt(document.getElementById('clearWeekSelect').value);
        const weeks = getWeeksForMonth(currentYear, currentMonth);
        const targetWeekDays = weeks[wIdx] || [];

        CLEAR_FIELDS.forEach(field => {
            const monthMap = appData[field][mKey];
            if (!monthMap) return;
            appData.duties.forEach(duty => {
                if (!monthMap[duty.id]) return;
                targetWeekDays.forEach(dObj => { delete monthMap[duty.id][dObj.getDate()]; });
            });
        });
        showUndoToast(`Cleared Week ${wIdx + 1} duties.`);
    } else if (scope === 'month') {
        appData.assignments[mKey] = {};
        appData.duties.forEach(duty => { appData.assignments[mKey][duty.id] = {}; });
        appData.ratings[mKey] = {};
        appData.absences[mKey] = {};
        showUndoToast(`Cleared entire month duties.`);
    } else if (scope === 'all') {
        appData.assignments = {};
        appData.ratings = {};
        appData.absences = {};
        showUndoToast(`Cleared all months & data.`);
    }

    closeClearDutiesModal();
    saveToStorage();
    renderPlanner();
}

let undoToastTimer = null;
function showUndoToast(msg) {
    const toast = document.getElementById('undoToast');
    document.getElementById('undoToastText').textContent = msg;
    toast.classList.remove('-translate-y-28', 'opacity-0', 'pointer-events-none');
    clearTimeout(undoToastTimer);
    undoToastTimer = setTimeout(hideUndoToast, 7000);
}
function hideUndoToast() {
    clearTimeout(undoToastTimer);
    const toast = document.getElementById('undoToast');
    if (toast) toast.classList.add('-translate-y-28', 'opacity-0', 'pointer-events-none');
}

function triggerUndo() {
    if (lastStateBackup) {
        appData = JSON.parse(JSON.stringify(lastStateBackup));
        lastStateBackup = null;
        saveToStorage();
        renderPlanner();
        hideUndoToast();
    }
}

/* ================= STUDENTS TAB ================= */

function renderStudentsTab() {
    const container = document.getElementById('studentsGridList');
    if (!container) return;
    let html = '';
    appData.students.forEach((student, idx) => {
        html += `
            <div class="bg-gray-50 p-4 rounded-2xl border border-gray-200 flex items-center justify-between shadow-sm">
                <div class="flex items-center space-x-3">
                    <span class="text-xs font-bold text-gray-400 w-6">#${idx + 1}</span>
                    <div>
                        <p class="font-bold text-sm text-gray-900">${esc(student.name)}</p>
                        <p class="text-xs text-gray-500">${esc(student.class)}</p>
                    </div>
                </div>
                <div class="flex items-center space-x-1">
                    <button onclick="editStudent(${idx})" class="text-gray-500 hover:text-brand-600 p-2" title="Rename / edit" aria-label="Rename or edit student"><i class="fa-solid fa-pen text-xs"></i></button>
                    <button onclick="moveStudent(${idx}, -1)" ${idx === 0 ? 'disabled class="text-gray-200 p-2 cursor-not-allowed"' : 'class="text-gray-500 hover:text-brand-600 p-2"'} title="Move Up" aria-label="Move up"><i class="fa-solid fa-arrow-up text-xs"></i></button>
                    <button onclick="moveStudent(${idx}, 1)" ${idx === appData.students.length - 1 ? 'disabled class="text-gray-200 p-2 cursor-not-allowed"' : 'class="text-gray-500 hover:text-brand-600 p-2"'} title="Move Down" aria-label="Move down"><i class="fa-solid fa-arrow-down text-xs"></i></button>
                    <button onclick="deleteStudent(${idx})" class="text-gray-400 hover:text-red-500 p-2 ml-2" title="Delete (kept in Archive)" aria-label="Delete (kept in Archive)"><i class="fa-solid fa-trash text-xs"></i></button>
                </div>
            </div>
        `;
    });
    container.innerHTML = html;
    updateArchiveBadge();
}

function moveStudent(idx, direction) {
    const targetIdx = idx + direction;
    if (targetIdx < 0 || targetIdx >= appData.students.length) return;
    const temp = appData.students[idx];
    appData.students[idx] = appData.students[targetIdx];
    appData.students[targetIdx] = temp;
    saveToStorage();
    renderStudentsTab();
}

function openStudentModal() {
    const rawName = prompt("Enter Student Full Name:");
    const name = rawName ? rawName.replace(/\s+/g, ' ').trim() : '';
    if (!name) return;
    if (appData.students.some(s => nameKey(s.name) === nameKey(name))) { alert("A student with this name already exists."); return; }
    const defCls = classLabel(currentProfile) || "Class 6R";
    const cls = prompt("Enter Student Class / Section:", defCls);
    appData.students.push({ id: newId('s'), name, class: (cls || defCls).trim() });
    saveToStorage();
    renderStudentsTab();
}

// Rename a student and/or change their class. History follows automatically (it is stored by ID).
function editStudent(idx) {
    const st = appData.students[idx];
    if (!st) return;
    const rawName = prompt("Student name:", st.name);
    if (rawName === null) return;
    const name = rawName.replace(/\s+/g, ' ').trim();
    if (!name) return;
    if (appData.students.some((o, i) => i !== idx && nameKey(o.name) === nameKey(name))) { alert("Another student already has this name."); return; }
    const rawCls = prompt("Class / Section:", st.class);
    if (rawCls === null) return;
    st.name = name;
    st.class = (rawCls.trim() || st.class);
    saveToStorage();
    renderStudentsTab();
    renderPlanner();
}

// Deleting a student also removes them from every assignment in every month
// "Delete" now ARCHIVES the student: they leave the Students list, Students view, Insights and the
// assignment pickers, but every record (schedule, absences, scores) is kept so they can be restored.
function deleteStudent(idx) {
    const st = appData.students[idx];
    if (!st) return;
    if (!confirm(`Archive ${st.name}?\n\nThey will be removed from the Students list, Students view and Insights, and will no longer be offered for new duties.\n\nAll their records are kept in the Archive, where you can restore them or delete them permanently.`)) return;
    appData.students.splice(idx, 1);
    if (!Array.isArray(appData.formerStudents)) appData.formerStudents = [];
    appData.formerStudents.push({ id: st.id, name: st.name, class: st.class, archived: true, archivedAt: Date.now() });
    saveToStorage();
    renderStudentsTab();
    if (!document.getElementById('tab-planner').classList.contains('hidden')) {
        renderPlanner();
    }
}

// Removes one student's ID from every assignment, absence and score in every month
function stripStudentFromAllData(removedId) {
    const stripName = (list) => (Array.isArray(list) ? list.filter(n => n !== removedId) : list);
    const eachCell = (field, fn) => {
        Object.keys(appData[field] || {}).forEach(mKey => {
            const map = appData[field][mKey];
            if (!map) return;
            Object.keys(map).forEach(dKey => {
                if (!map[dKey]) return;
                Object.keys(map[dKey]).forEach(dayNum => { fn(map[dKey], dayNum); });
            });
        });
    };
    eachCell('assignments', (days, dayNum) => { days[dayNum] = stripName(days[dayNum]); });
    eachCell('absences', (days, dayNum) => { days[dayNum] = stripName(days[dayNum]); });
    eachCell('ratings', (days, dayNum) => { if (days[dayNum]) delete days[dayNum][removedId]; });
}

// How many records exist for one student (used in the Archive list and the delete warning)
function countStudentRecords(id) {
    let duties = 0, absences = 0, scores = 0;
    Object.values(appData.assignments || {}).forEach(m => Object.values(m || {}).forEach(days => Object.values(days || {}).forEach(l => { if ((l || []).includes(id)) duties++; })));
    Object.values(appData.absences || {}).forEach(m => Object.values(m || {}).forEach(days => Object.values(days || {}).forEach(l => { if ((l || []).includes(id)) absences++; })));
    Object.values(appData.ratings || {}).forEach(m => Object.values(m || {}).forEach(days => Object.values(days || {}).forEach(o => { if (o && o[id]) scores++; })));
    return { duties, absences, scores };
}

/* ================= ARCHIVE (archived students) ================= */
function updateArchiveBadge() {
    const el = document.getElementById('archiveCountBadge');
    if (!el) return;
    const n = (appData.formerStudents || []).length;
    el.textContent = n;
    el.classList.toggle('hidden', n === 0);
}
function openArchiveModal() {
    renderArchiveModal();
    document.getElementById('archiveModal').classList.remove('hidden');
}
function closeArchiveModal() { document.getElementById('archiveModal').classList.add('hidden'); }
function renderArchiveModal() {
    const list = document.getElementById('archiveList');
    if (!list) return;
    const items = appData.formerStudents || [];
    if (!items.length) {
        list.innerHTML = '<div class="text-center text-sm text-gray-400 py-10"><i class="fa-solid fa-box-archive text-2xl mb-3 block"></i>No archived students.<br><span class="text-xs">Students you delete are kept here.</span></div>';
        return;
    }
    list.innerHTML = items.map((f, i) => {
        const c = countStudentRecords(f.id);
        const when = f.archivedAt
            ? 'Archived ' + new Date(f.archivedAt).toLocaleDateString('en-GB', { day: 'numeric', month: 'short', year: 'numeric' })
            : 'Found in old records';
        const cls = (f.class && f.class !== 'former student') ? f.class : '';
        return `
        <div class="bg-gray-50 p-3 rounded-2xl border border-gray-200 flex items-center justify-between gap-3 shadow-sm">
            <div class="min-w-0">
                <p class="font-bold text-sm text-gray-900 truncate">${esc(f.name)}</p>
                <p class="text-xs text-gray-500 truncate">${cls ? esc(cls) + ' &bull; ' : ''}${when}</p>
                <p class="text-[11px] text-gray-400">${c.duties} duty record${c.duties === 1 ? '' : 's'} &bull; ${c.scores} score${c.scores === 1 ? '' : 's'} &bull; ${c.absences} absence${c.absences === 1 ? '' : 's'}</p>
            </div>
            <div class="flex flex-col sm:flex-row gap-2 shrink-0">
                <button onclick="restoreStudent(${i})" class="text-xs font-semibold px-3 py-1.5 rounded-lg border border-brand-500 text-brand-600 hover:bg-brand-50 transition"><i class="fa-solid fa-rotate-left mr-1"></i>Restore</button>
                <button onclick="purgeStudent(${i})" class="text-xs font-semibold px-3 py-1.5 rounded-lg border border-red-200 text-red-600 hover:bg-red-50 transition"><i class="fa-solid fa-trash mr-1"></i>Delete forever</button>
            </div>
        </div>`;
    }).join('');
}

// Bring an archived student back onto the roster with all their records intact
function restoreStudent(i) {
    const f = (appData.formerStudents || [])[i];
    if (!f) return;
    if (appData.students.some(st => nameKey(st.name) === nameKey(f.name))) {
        alert(`A student named "${f.name}" is already on the Students list. Rename that student first, then restore.`);
        return;
    }
    let cls = f.class;
    if (!cls || cls === 'former student') {
        const def = classLabel(currentProfile) || 'Class 6R';
        const ans = prompt(`Class / Section for ${f.name}:`, def);
        if (ans === null) return;
        cls = ans.trim() || def;
    }
    appData.formerStudents.splice(i, 1);
    appData.students.push({ id: f.id, name: f.name, class: cls });
    saveToStorage();
    renderStudentsTab();
    renderArchiveModal();
    if (!document.getElementById('tab-planner').classList.contains('hidden')) renderPlanner();
}

// Erase an archived student and every record of them, for good
function purgeStudent(i) {
    const f = (appData.formerStudents || [])[i];
    if (!f) return;
    const c = countStudentRecords(f.id);
    if (!confirm(`Delete ${f.name} permanently?\n\nThis erases ${c.duties} duty record(s), ${c.scores} score(s) and ${c.absences} absence mark(s) from every month.\n\nThis cannot be undone.`)) return;
    stripStudentFromAllData(f.id);
    appData.formerStudents.splice(i, 1);
    saveToStorage();
    renderStudentsTab();
    renderArchiveModal();
    if (!document.getElementById('tab-planner').classList.contains('hidden')) renderPlanner();
}

/* ================= DUTIES TAB ================= */

function renderDutiesTab() {
    const container = document.getElementById('dutiesListContainer');
    if (!container) return;
    let html = '';
    appData.duties.forEach((duty, idx) => {
        html += `
            <div class="bg-gray-50 p-4 rounded-2xl border border-gray-200 flex items-center justify-between">
                <div class="flex items-center space-x-3">
                    <span class="w-7 h-7 rounded-lg bg-brand-100 text-brand-900 flex items-center justify-center font-bold text-xs">${idx + 1}</span>
                    <span class="font-semibold text-sm text-gray-900">${esc(duty.name)}</span>
                </div>
                <div class="flex items-center space-x-1">
                    <button onclick="editDuty(${idx})" class="text-gray-500 hover:text-brand-600 p-2" title="Rename" aria-label="Rename duty"><i class="fa-solid fa-pen text-xs"></i></button>
                    <button onclick="moveDuty(${idx}, -1)" ${idx === 0 ? 'disabled class="text-gray-200 p-2 cursor-not-allowed"' : 'class="text-gray-500 hover:text-brand-600 p-2"'} title="Move Up" aria-label="Move up"><i class="fa-solid fa-arrow-up text-xs"></i></button>
                    <button onclick="moveDuty(${idx}, 1)" ${idx === appData.duties.length - 1 ? 'disabled class="text-gray-200 p-2 cursor-not-allowed"' : 'class="text-gray-500 hover:text-brand-600 p-2"'} title="Move Down" aria-label="Move down"><i class="fa-solid fa-arrow-down text-xs"></i></button>
                    <button onclick="deleteDuty(${idx})" class="text-gray-400 hover:text-red-500 p-2 ml-2" title="Delete" aria-label="Delete"><i class="fa-solid fa-trash text-xs"></i></button>
                </div>
            </div>
        `;
    });
    container.innerHTML = html;
}

function moveDuty(idx, direction) {
    const targetIdx = idx + direction;
    if (targetIdx < 0 || targetIdx >= appData.duties.length) return;

    // Assignments are stored by duty ID, so reordering only changes the list order.
    const tempDuty = appData.duties[idx];
    appData.duties[idx] = appData.duties[targetIdx];
    appData.duties[targetIdx] = tempDuty;

    saveToStorage();
    renderDutiesTab();
    renderPlanner();
}

function openDutyModal() {
    const rawDuty = prompt("Enter New Assembly Duty Title:");
    const dutyName = rawDuty ? rawDuty.replace(/\s+/g, ' ').trim() : '';
    if (!dutyName) return;
    const duty = { id: newId('d'), name: dutyName };
    appData.duties.push(duty);
    Object.keys(appData.assignments).forEach(mKey => {
        if (!appData.assignments[mKey]) appData.assignments[mKey] = {};
        appData.assignments[mKey][duty.id] = {};
    });
    saveToStorage();
    renderDutiesTab();
    renderPlanner();
}

// Rename a duty. History follows automatically (it is stored by ID).
function editDuty(idx) {
    const duty = appData.duties[idx];
    if (!duty) return;
    const raw = prompt("Duty title:", duty.name);
    if (raw === null) return;
    const name = raw.replace(/\s+/g, ' ').trim();
    if (!name) return;
    if (appData.duties.some((d, i) => i !== idx && nameKey(d.name) === nameKey(name))) { alert("Another duty already has this title."); return; }
    duty.name = name;
    saveToStorage();
    renderDutiesTab();
    renderPlanner();
}

function deleteDuty(idx) {
    if (!confirm("Delete this duty? Its assignments, scores and absence marks will be removed.")) return;
    const removed = appData.duties[idx];
    if (!removed) return;
    appData.duties.splice(idx, 1);
    // Remove only this duty's data - every other duty keeps its ID, so nothing needs re-numbering
    ['assignments', 'ratings', 'absences'].forEach(field => {
        Object.keys(appData[field] || {}).forEach(mKey => {
            const map = appData[field][mKey];
            if (map) delete map[removed.id];
        });
    });
    saveToStorage();
    renderDutiesTab();
    renderPlanner();
}

/* ================= CLEAN (PRINT) VIEW ================= */

function toggleCleanViewControls() {
    const wrapper = document.getElementById('cleanViewControls');
    const icon = document.getElementById('cleanViewToggleIcon');
    const text = document.getElementById('cleanViewToggleText');

    cleanViewControlsVisible = !cleanViewControlsVisible;

    if (cleanViewControlsVisible) {
        wrapper.style.maxHeight = '300px';
        icon.classList.remove('fa-chevron-down');
        icon.classList.add('fa-chevron-up');
        text.textContent = 'Hide Controls';
    } else {
        wrapper.style.maxHeight = '0px';
        icon.classList.remove('fa-chevron-up');
        icon.classList.add('fa-chevron-down');
        text.textContent = 'Show Controls';
    }
}

function openCleanViewModal() {
    const monthNames = ["January", "February", "March", "April", "May", "June", "July", "August", "September", "October", "November", "December"];
    document.getElementById('cleanViewTitle').textContent = `Morning Assembly Duty Schedule - ${monthNames[currentMonth]} ${currentYear}`;

    // Same full Mon-Sat weeks as the planner (including days borrowed from the neighbouring months)
    const weeks = getPaddedWeeksForMonth(currentYear, currentMonth);
    const weekContainer = document.getElementById('cleanWeekCheckboxesContainer');
    let weekChkHtml = '';
    weeks.forEach((wk, wIdx) => {
        weekChkHtml += `<label class="cursor-pointer px-2.5 py-1 rounded bg-gray-700 text-white hover:bg-gray-600 whitespace-nowrap select-none"><input type="checkbox" class="clean-week-chk mr-1" value="${wIdx}" checked onchange="renderCleanTable()"> Wk ${wIdx + 1} (${weekRangeLabel(wk)})</label>`;
    });
    weekContainer.innerHTML = weekChkHtml;

    cleanViewSelectedWeekdays = [1, 2, 3, 4, 5, 6];
    renderCleanWeekdayCheckboxes();
    renderCleanTable();

    currentZoom = 1;
    document.getElementById('cleanTableWrapper').style.transform = `scale(1)`;
    document.getElementById('zoomLevelLabel').textContent = `100%`;
    document.getElementById('cleanViewModal').classList.remove('hidden');
}

function renderCleanWeekdayCheckboxes() {
    const dayContainer = document.getElementById('cleanDayCheckboxesContainer');
    const weekdayNames = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];
    let html = `<span class="text-gray-400 font-semibold mr-2">Days:</span>`;

    [1, 2, 3, 4, 5, 6].forEach(dayNum => {
        const isChecked = cleanViewSelectedWeekdays.includes(dayNum) ? 'checked' : '';
        html += `<label class="cursor-pointer px-2 py-0.5 rounded bg-gray-700 text-white hover:bg-gray-600 whitespace-nowrap mr-1 select-none"><input type="checkbox" class="clean-day-chk mr-1" value="${dayNum}" ${isChecked} onchange="toggleCleanWeekday(this)"> ${weekdayNames[dayNum]}</label>`;
    });
    dayContainer.innerHTML = html;
}

function toggleCleanWeekday(chk) {
    const dayNum = parseInt(chk.value);
    if (chk.checked) {
        if (!cleanViewSelectedWeekdays.includes(dayNum)) cleanViewSelectedWeekdays.push(dayNum);
    } else {
        cleanViewSelectedWeekdays = cleanViewSelectedWeekdays.filter(d => d !== dayNum);
    }
    renderCleanTable();
}

function toggleAllCleanWeeks(selectState) {
    document.querySelectorAll('.clean-week-chk').forEach(chk => chk.checked = selectState);
    renderCleanTable();
}

function renderCleanTable() {
    const cleanTable = document.getElementById('cleanTable');
    const weekCheckboxes = document.querySelectorAll('.clean-week-chk');
    let activeWeekIndices = [];
    weekCheckboxes.forEach(chk => {
        if (chk.checked) activeWeekIndices.push(parseInt(chk.value));
    });

    const weeks = getPaddedWeeksForMonth(currentYear, currentMonth);
    const monthStart = new Date(currentYear, currentMonth, 1);
    const isPad = dObj => dObj.getMonth() !== currentMonth || dObj.getFullYear() !== currentYear;

    // Same two filters as before (ticked weeks AND ticked weekdays) - now applied to the full weeks,
    // so days borrowed from the neighbouring months follow the exact same rules.
    let visibleDays = [];
    weeks.forEach((wk, wIdx) => {
        if (activeWeekIndices.includes(wIdx)) {
            wk.forEach(dObj => {
                if (cleanViewSelectedWeekdays.includes(dObj.getDay())) {
                    visibleDays.push(dObj);
                }
            });
        }
    });
    visibleDays.sort((a, b) => a - b);

    let html = `<thead><tr class="bg-gray-100 border-b"><th class="p-3 border-r font-bold w-48 bg-gray-50" style="position:sticky;left:0;z-index:20;background:#f9fafb;">DUTY / DATE</th>`;
    visibleDays.forEach(dObj => {
        const dayStr = dObj.toLocaleDateString('en-US', { weekday: 'short', month: 'short', day: 'numeric' });
        const pad = isPad(dObj);
        const tag = pad ? `<span class="block text-[9px] font-semibold text-slate-500 uppercase tracking-wide">${dObj < monthStart ? 'Prev month' : 'Next month'}</span>` : '';
        html += `<th class="p-3 border-r font-bold text-center min-w-[120px] whitespace-nowrap${pad ? ' pad-day' : ''}">${dayStr}${tag}</th>`;
    });
    html += `</tr></thead><tbody class="divide-y">`;

    appData.duties.forEach((duty, dIdx) => {
        html += `<tr><td class="p-3 border-r font-semibold bg-gray-50 text-gray-900" style="position:sticky;left:0;z-index:10;background:#fff;">${esc(duty.name)}</td>`;
        visibleDays.forEach(dObj => {
            const dateNum = dObj.getDate();
            const cellKey = getMonthKey(dObj.getFullYear(), dObj.getMonth());   // each day reads from ITS OWN month
            const list = (appData.assignments[cellKey] && appData.assignments[cellKey][duty.id] && appData.assignments[cellKey][duty.id][dateNum]) || [];
            const names = list.map(n => esc(studentName(n))).join(', ');
            const holidayCell = isHolidayDate(dObj.getFullYear(), dObj.getMonth(), dateNum);
            html += `<td class="p-3 border-r text-sm text-gray-700 whitespace-nowrap${isPad(dObj) ? ' pad-day' : ''}">${names || (holidayCell ? '<span class="text-red-500 font-semibold">Holiday</span>' : '-')}</td>`;
        });
        html += `</tr>`;
    });
    html += `</tbody>`;
    cleanTable.innerHTML = html;
}

function closeCleanViewModal() {
    document.getElementById('cleanViewModal').classList.add('hidden');
}

function adjustZoom(amount) {
    currentZoom = Math.max(0.5, Math.min(1.8, currentZoom + amount));
    document.getElementById('cleanTableWrapper').style.transform = `scale(${currentZoom})`;
    document.getElementById('zoomLevelLabel').textContent = `${Math.round(currentZoom * 100)}%`;
}

/* ================= CSV EXPORT / IMPORT ================= */

// Wrap a value for CSV: any double quote inside must be doubled ("" ) or the file breaks.
function csvCell(v) {
    return '"' + String(v == null ? '' : v).replace(/"/g, '""') + '"';
}

const CSV_MON = ["Jan","Feb","Mar","Apr","May","Jun","Jul","Aug","Sep","Oct","Nov","Dec"];
function csvDateStr(y, m, d) { return `${String(d).padStart(2, '0')}-${CSV_MON[m]}-${y}`; }
function csvMonthLabel(mKey) { const p = mKey.split('-').map(Number); return `${CSV_MON[p[1] - 1]} ${p[0]}`; }
function ensurePath(root, keys) { let o = root; keys.forEach(k => { if (!o[k]) o[k] = {}; o = o[k]; }); return o; }

// Export controls start on the month currently open in the planner
function initExportControls() {
    const s = document.getElementById('expStart');
    if (s) s.value = getMonthKey(currentYear, currentMonth);
}

/* EXPORT (format v2): a few "info" rows (profile, content, range, holidays),
   then one row per student per duty per day:  Date, Duty, Student, Status, Score, Remark */
function exportCSV() {
    const type = document.getElementById('expContent').value;          // combined | assignments | performance
    const startVal = document.getElementById('expStart').value;
    const count = Math.min(3, Math.max(1, parseInt(document.getElementById('expCount').value, 10) || 1));
    if (!/^\d{4}-\d{2}$/.test(startVal)) { alert('Pick the first month to export.'); return; }

    let y = +startVal.slice(0, 4), m = +startVal.slice(5, 7) - 1;
    const months = [];
    for (let i = 0; i < count; i++) { months.push({ y, m, mKey: getMonthKey(y, m) }); m++; if (m > 11) { m = 0; y++; } }
    const wantA = type !== 'performance', wantP = type !== 'assignments';

    const rows = [], holi = [], over = [];
    months.forEach(({ y, m, mKey }) => {
        const amap = (appData.assignments || {})[mKey] || {};
        const days = new Set();
        appData.duties.forEach(d => Object.keys(amap[d.id] || {}).forEach(k => days.add(+k)));
        [...days].sort((a, b) => a - b).forEach(day => {
            appData.duties.forEach(duty => {
                const list = ((amap[duty.id] || {})[day]) || [];
                const abs = ((((appData.absences || {})[mKey] || {})[duty.id]) || {})[day] || [];
                const rat = ((((appData.ratings || {})[mKey] || {})[duty.id]) || {})[day] || {};
                list.forEach(sid => {
                    let status = '', score = '', remark = '';
                    if (wantP) {
                        const r = rat[sid];
                        if (abs.includes(sid)) status = 'Not performed';
                        else if (r && r.score) { status = 'Performed'; score = r.score; remark = String(r.remark || '').replace(/[\r\n]+/g, ' '); }
                    }
                    if (!wantA && !status) return;               // performance-only: skip students with no score / not-performed mark
                    rows.push([csvDateStr(y, m, day), duty.name, studentName(sid), status, score, remark]);
                });
            });
        });
        const dim = new Date(y, m + 1, 0).getDate();
        for (let d = 1; d <= dim; d++) {
            if (new Date(y, m, d).getDay() === 0) continue;
            if (isHolidayDate(y, m, d)) holi.push(csvDateStr(y, m, d));
            if ((appData.workingOverrides || []).includes(isoOf(y, m, d))) over.push(csvDateStr(y, m, d));
        }
    });
    if (!rows.length && !holi.length) { alert('There is nothing to export for that range.'); return; }

    const p = currentProfile || {};
    const label = { combined: 'Combined (assignments + performance)', assignments: 'Assignments only', performance: 'Performance only' }[type];
    const f = months[0], l = months[months.length - 1];
    const out = [
        ['PDP Duty Planner Export', 'v2'],
        ['Profile name', p.name || ''],
        ['Profile ID', p.id || ''],
        ['Content', label],
        ['From month', `${CSV_MON[f.m]} ${f.y}`],
        ['To month', `${CSV_MON[l.m]} ${l.y}`],
        ['Exported on', new Date().toLocaleString('en-GB')],
        ['Holidays', holi.join('; ')],
        ['Working-day overrides', over.join('; ')],
        [],
        ['Date', 'Duty', 'Student', 'Status', 'Score', 'Remark']
    ].concat(rows);
    const csv = '\uFEFF' + out.map(r => r.map(csvCell).join(',')).join('\r\n');

    const blob = new Blob([csv], { type: 'text/csv;charset=utf-8' });
    const a = document.createElement('a');
    a.href = URL.createObjectURL(blob);
    a.download = `pdp_${p.id || 'profile'}_${type}_${f.mKey}${count > 1 ? '_to_' + l.mKey : ''}.csv`;
    document.body.appendChild(a);
    a.click();
    a.remove();
    setTimeout(() => URL.revokeObjectURL(a.href), 3000);
}

function parseCSVLine(line) {
    const result = [];
    let current = '';
    let inQuotes = false;
    for (let i = 0; i < line.length; i++) {
        const char = line[i];
        const nextChar = line[i + 1];
        if (char === '"') {
            if (inQuotes && nextChar === '"') {
                current += '"';
                i++;
            } else {
                inQuotes = !inQuotes;
            }
        } else if (char === ',' && !inQuotes) {
            result.push(current.trim());
            current = '';
        } else {
            current += char;
        }
    }
    result.push(current.trim());
    return result;
}

/* ---------- IMPORT: read the file ---------- */
let pendingImport = null;

// Older export format: a grid with one column per date (assignments only)
function parseLegacyGrid(lines) {
    const header = parseCSVLine(lines[0]);
    const colDates = header.slice(1).map(h => parseCSVDate(h));
    if (colDates.every(d => d === null)) return { error: 'Could not read any dates from the CSV header.\nExpected dates like 01-Jul-2026, or a file exported by this app.' };
    const records = [];
    for (let i = 1; i < lines.length; i++) {
        if (!lines[i].trim()) continue;
        const cols = parseCSVLine(lines[i]);
        const duty = (cols[0] || '').trim();
        if (!duty) continue;
        colDates.forEach((dt, c) => {
            if (!dt) return;
            (cols[c + 1] || '').split(';').map(s => s.trim()).filter(Boolean).forEach(n =>
                records.push({ year: dt.year, month: dt.month, day: dt.day, mKey: dt.mKey, duty, student: n, status: '', score: 0, remark: '' }));
        });
    }
    return { meta: {}, records, holidays: [], overrides: [], legacy: true };
}

function parseImportText(text) {
    if (text.charCodeAt(0) === 0xFEFF) text = text.slice(1);
    const lines = text.split(/\r\n|\n|\r/);
    if (lines.length < 2) return { error: 'Invalid CSV format.' };
    const first = parseCSVLine(lines[0]);
    if (!/^PDP Duty Planner Export/i.test(first[0] || '')) return parseLegacyGrid(lines);

    const meta = {};
    let i = 1, found = false;
    for (; i < lines.length; i++) {
        if (!lines[i].trim()) continue;
        const c = parseCSVLine(lines[i]);
        if (/^date$/i.test(c[0]) && /^duty$/i.test(c[1] || '')) { found = true; i++; break; }
        meta[(c[0] || '').toLowerCase()] = c[1] || '';
    }
    if (!found) return { error: 'This file has no data table (the "Date, Duty, Student" header row is missing).' };

    const records = [];
    let bad = 0;
    for (; i < lines.length; i++) {
        if (!lines[i].trim()) continue;
        const c = parseCSVLine(lines[i]);
        const dt = parseCSVDate(c[0] || '');
        if (!dt || !c[1] || !c[2]) { bad++; continue; }
        let score = parseInt(c[4], 10);
        if (!(score >= 1 && score <= 5)) score = 0;
        records.push({ year: dt.year, month: dt.month, day: dt.day, mKey: dt.mKey, duty: c[1], student: c[2], status: (c[3] || '').toLowerCase(), score, remark: c[5] || '' });
    }
    const dates = s => (s || '').split(';').map(x => parseCSVDate(x.trim())).filter(Boolean);
    return { meta, records, bad, holidays: dates(meta['holidays']), overrides: dates(meta['working-day overrides']) };
}

function importCSV() {
    const fi = document.getElementById('csvFileInput');
    if (!fi.files.length) { alert('Please select a CSV file first.'); return; }
    const file = fi.files[0];
    const reader = new FileReader();
    reader.onload = function (e) {
        const res = parseImportText(String(e.target.result || ''));
        if (res.error) { alert(res.error); return; }
        const months = new Set();
        res.records.forEach(r => months.add(r.mKey));
        res.holidays.concat(res.overrides).forEach(h => months.add(h.mKey));
        if (!months.size) { alert('No duty records or holidays were found in this file.'); return; }
        res.months = [...months].sort();
        res.fileName = file.name;
        const fid = String((res.meta || {})['profile id'] || '').toLowerCase();
        res.mismatch = !!fid && !!currentProfile && fid !== String(currentProfile.id).toLowerCase();
        pendingImport = res;
        renderImportModal();
        document.getElementById('importModal').classList.remove('hidden');
    };
    reader.readAsText(file);
}

/* ---------- IMPORT: review window ---------- */
function lookupStudent(name) {
    const k = nameKey(name);
    const s = appData.students.find(x => nameKey(x.name) === k) || (appData.formerStudents || []).find(x => nameKey(x.name) === k);
    return s ? s.id : null;
}
function dutyIdByName(name) { const i = findDutyIndex(name); return i === -1 ? null : appData.duties[i].id; }
function getSlot(field, mk, did, day, fallback) { return ((((appData[field] || {})[mk] || {})[did]) || {})[day] || fallback; }

function closeImportModal() {
    document.getElementById('importModal').classList.add('hidden');
    pendingImport = null;
}

function renderImportModal() {
    const P = pendingImport, m = P.meta || {};
    const cur = currentProfile || {};
    const fileProfile = m['profile name'] ? `${esc(m['profile name'])} (@${esc(m['profile id'] || '')})` : '';
    const hasPerf = P.records.some(r => r.status || r.score);
    const hasHol = (P.holidays.length + P.overrides.length) > 0;
    const counts = {};
    P.records.forEach(r => { counts[r.mKey] = (counts[r.mKey] || 0) + 1; });

    let prof;
    if (!m['profile id']) {
        prof = `<div class="p-3 rounded-xl bg-gray-50 border border-gray-200 text-xs text-gray-600"><i class="fa-solid fa-circle-info text-brand-500 mr-1.5"></i>This file has no profile information (older format). It will be imported into <b>${esc(cur.name)}</b>.</div>`;
    } else if (!P.mismatch) {
        prof = `<div class="p-3 rounded-xl bg-emerald-50 border border-emerald-200 text-xs text-emerald-800"><i class="fa-solid fa-circle-check mr-1.5"></i>File exported from this profile: <b>${fileProfile}</b>.</div>`;
    } else {
        prof = `<div class="p-3 rounded-xl bg-red-50 border border-red-300 text-xs text-red-800 space-y-2">
            <p><i class="fa-solid fa-triangle-exclamation mr-1.5"></i><b>Different profile.</b> This file belongs to <b>${fileProfile}</b>, but you are logged in as <b>${esc(cur.name)}</b> (@${esc(cur.id)}).</p>
            <label class="flex items-start gap-2 cursor-pointer"><input type="checkbox" id="impProfileOk" onchange="updateImportPreview()" class="mt-0.5 accent-red-600"><span>Yes, I want to import ${esc(m['profile name'] || 'that profile')}'s data into <b>${esc(cur.name)}</b>'s profile.</span></label>
        </div>`;
    }

    const unknownStudents = [...new Set(P.records.map(r => r.student).filter(n => !lookupStudent(n)))];
    const unknownDuties = [...new Set(P.records.map(r => r.duty).filter(n => !dutyIdByName(n)))];
    const chk = (id, label, on, off) => `<label class="flex items-center gap-2 text-sm ${off ? 'text-gray-300' : 'text-gray-800 cursor-pointer'}"><input type="checkbox" id="${id}" ${on ? 'checked' : ''} ${off ? 'disabled' : ''} onchange="updateImportPreview()" class="accent-brand-500">${label}</label>`;

    document.getElementById('importBody').innerHTML = `
        <p class="text-xs text-gray-500 truncate"><i class="fa-regular fa-file mr-1"></i>${esc(P.fileName)}${m['content'] ? ' &bull; ' + esc(m['content']) : ''}</p>
        ${prof}
        <div>
            <p class="text-xs font-bold text-gray-700 mb-1.5">Months to import</p>
            <div class="flex flex-wrap gap-2">${P.months.map(mk => `<label class="flex items-center gap-1.5 px-2.5 py-1.5 rounded-lg border border-gray-300 text-xs cursor-pointer"><input type="checkbox" class="imp-mon accent-brand-500" value="${mk}" checked onchange="updateImportPreview()">${esc(csvMonthLabel(mk))} <span class="text-gray-400">(${counts[mk] || 0})</span></label>`).join('')}</div>
        </div>
        <div>
            <p class="text-xs font-bold text-gray-700 mb-1.5">What to import</p>
            <div class="space-y-1.5">
                ${chk('impAssign', 'Assignments (who did which duty)', P.records.length > 0, P.records.length === 0)}
                ${chk('impPerf', 'Performance (scores, remarks, not-performed)', hasPerf, !hasPerf)}
                ${chk('impHol', 'Holidays marked', hasHol, !hasHol)}
            </div>
        </div>
        ${(unknownStudents.length || unknownDuties.length) ? `<div class="p-3 rounded-xl bg-amber-50 border border-amber-200 text-xs text-amber-900 space-y-1.5">
            ${unknownDuties.length ? `<p><b>Duties not found</b> (their rows will be skipped): ${esc(unknownDuties.join(', '))}</p>` : ''}
            ${unknownStudents.length ? `<p><b>${unknownStudents.length} student name(s) not on your list:</b> ${esc(unknownStudents.slice(0, 8).join(', '))}${unknownStudents.length > 8 ? '...' : ''}</p>
            <label class="flex items-start gap-2 cursor-pointer"><input type="checkbox" id="impAddStudents" class="mt-0.5 accent-brand-500"><span>Add them to my Students list (otherwise they are kept as archived "former students" and stay out of the Students view)</span></label>` : ''}
        </div>` : ''}
        <div id="impConflictBox" class="hidden p-3 rounded-xl bg-brand-50 border border-brand-500/40 text-xs space-y-2">
            <p id="impConflictText" class="font-semibold text-gray-800"></p>
            <label class="flex items-start gap-2 cursor-pointer"><input type="radio" name="impConflict" value="skip" checked onchange="updateImportPreview()" class="mt-0.5 accent-brand-500"><span><b>Keep mine</b> - skip slots that already have students (nothing existing is changed)</span></label>
            <label class="flex items-start gap-2 cursor-pointer"><input type="radio" name="impConflict" value="merge" onchange="updateImportPreview()" class="mt-0.5 accent-brand-500"><span><b>Merge</b> - add the file's students to the existing ones; keep existing scores</span></label>
            <label class="flex items-start gap-2 cursor-pointer"><input type="radio" name="impConflict" value="overwrite" onchange="updateImportPreview()" class="mt-0.5 accent-brand-500"><span><b>Overwrite</b> - replace existing students, scores and holidays in those months with the file's</span></label>
        </div>
        <p id="impSummary" class="text-xs text-gray-500"></p>
        ${P.bad ? `<p class="text-[11px] text-amber-600">${P.bad} unreadable row(s) in the file will be ignored.</p>` : ''}`;
    updateImportPreview();
}

function importOpts() {
    const g = id => { const e = document.getElementById(id); return !!(e && e.checked && !e.disabled); };
    return {
        months: new Set([...document.querySelectorAll('.imp-mon')].filter(c => c.checked).map(c => c.value)),
        incA: g('impAssign'), incP: g('impPerf'), incH: g('impHol'),
        mode: (document.querySelector('input[name="impConflict"]:checked') || {}).value || 'skip',
        addStudents: g('impAddStudents'), profOk: g('impProfileOk')
    };
}

function updateImportPreview() {
    const P = pendingImport;
    if (!P) return;
    const o = importOpts();
    const seen = new Set();
    let slotConf = 0, perfConf = 0, used = 0;
    P.records.forEach(r => {
        if (!o.months.has(r.mKey)) return;
        const did = dutyIdByName(r.duty);
        if (!did) return;
        used++;
        const ex = getSlot('assignments', r.mKey, did, r.day, []);
        const key = r.mKey + '|' + did + '|' + r.day;
        if (o.incA && ex.length && !seen.has(key)) { seen.add(key); slotConf++; }
        if (o.incP && (r.status || r.score)) {
            const id = lookupStudent(r.student);
            if (id && ex.includes(id) && (getSlot('ratings', r.mKey, did, r.day, {})[id] || getSlot('absences', r.mKey, did, r.day, []).includes(id))) perfConf++;
        }
    });
    const box = document.getElementById('impConflictBox');
    const n = slotConf + perfConf;
    box.classList.toggle('hidden', n === 0);
    if (n) document.getElementById('impConflictText').textContent =
        `Conflict: ${slotConf} slot(s) already have students assigned` + (perfConf ? ` and ${perfConf} existing score / not-performed mark(s) would be affected` : '') + '. How should this be handled?';
    document.getElementById('impSummary').textContent = `${used} record(s) in the selected months.`;
    const btn = document.getElementById('impConfirmBtn');
    const ok = o.months.size > 0 && (o.incA || o.incP || o.incH) && (!P.mismatch || o.profOk);
    btn.disabled = !ok;
    btn.classList.toggle('opacity-50', !ok);
    btn.classList.toggle('cursor-not-allowed', !ok);
}

/* ---------- IMPORT: apply ---------- */
function applyImport() {
    const P = pendingImport;
    if (!P) return;
    const o = importOpts();
    if ((P.mismatch && !o.profOk) || !o.months.size || !(o.incA || o.incP || o.incH)) return;

    lastStateBackup = JSON.parse(JSON.stringify(appData));
    ['assignments', 'ratings', 'absences'].forEach(f => { if (!appData[f]) appData[f] = {}; });
    const st = { added: 0, skipped: 0, overwritten: 0, merged: 0, perf: 0, perfSkipped: 0, notAssigned: 0, newStudents: new Set(), badDuties: new Set(), holidays: 0 };

    const resolveStudent = (name) => {
        let id = lookupStudent(name);
        if (id) return id;
        if (o.addStudents) {
            const s = { id: newId('s'), name: String(name).replace(/\s+/g, ' ').trim(), class: classLabel(currentProfile) || '' };
            appData.students.push(s);
            id = s.id;
        } else {
            id = getOrCreateFormerStudent(name).id;
        }
        st.newStudents.add(name);
        return id;
    };

    if (o.incA || o.incP) {
        const slots = new Map();
        P.records.forEach(r => {
            if (!o.months.has(r.mKey)) return;
            const did = dutyIdByName(r.duty);
            if (!did) { st.badDuties.add(r.duty); return; }
            const key = r.mKey + '|' + did + '|' + r.day;
            let s = slots.get(key);
            if (!s) { s = { mk: r.mKey, did, day: r.day, recs: [] }; slots.set(key, s); }
            s.recs.push(r);
        });

        slots.forEach(s => {
            const A = ensurePath(appData.assignments, [s.mk, s.did]);
            const R = ensurePath(appData.ratings, [s.mk, s.did]);
            const X = ensurePath(appData.absences, [s.mk, s.did]);
            const existing = A[s.day] || [];
            const fileNames = [];
            s.recs.forEach(r => { if (!fileNames.some(n => nameKey(n) === nameKey(r.student))) fileNames.push(r.student); });

            let final = existing.slice();
            if (o.incA) {
                if (existing.length && o.mode === 'skip') { st.skipped++; return; }          // leave this slot completely alone
                if (existing.length && o.mode === 'overwrite') { final = []; st.overwritten++; }
                else if (existing.length) st.merged++;
                else st.added++;
                fileNames.forEach(n => { const id = resolveStudent(n); if (!final.includes(id)) final.push(id); });
                A[s.day] = final;
            }

            const rObj = R[s.day] || {};
            let xArr = (X[s.day] || []).slice();
            if (o.incA && o.mode === 'overwrite' && existing.length) {
                if (o.incP) { Object.keys(rObj).forEach(k => delete rObj[k]); xArr = []; }
                else { Object.keys(rObj).forEach(k => { if (!final.includes(k)) delete rObj[k]; }); xArr = xArr.filter(id => final.includes(id)); }
            }
            if (o.incP) {
                s.recs.forEach(r => {
                    if (!r.status && !r.score) return;
                    const id = lookupStudent(r.student);
                    if (!id || !final.includes(id)) { st.notAssigned++; return; }
                    const had = !!rObj[id] || xArr.includes(id);
                    if (had && o.mode !== 'overwrite') { st.perfSkipped++; return; }
                    if (/not\s*perf|absent/.test(r.status)) { delete rObj[id]; if (!xArr.includes(id)) xArr.push(id); }
                    else if (r.score) { rObj[id] = { score: r.score, remark: r.remark || '' }; xArr = xArr.filter(x => x !== id); }
                    else return;
                    st.perf++;
                });
            }
            R[s.day] = rObj;
            X[s.day] = xArr;
        });
    }

    if (o.incH) {
        const hs = new Set(appData.holidays || []), os = new Set(appData.workingOverrides || []);
        const before = new Set([...hs, ...[...os].map(x => 'o' + x)]);
        const inM = iso => o.months.has(iso.slice(0, 7));
        if (o.mode === 'overwrite') { [...hs].forEach(i => { if (inM(i)) hs.delete(i); }); [...os].forEach(i => { if (inM(i)) os.delete(i); }); }
        P.holidays.forEach(h => {
            if (!o.months.has(h.mKey) || new Date(h.year, h.month, h.day).getDay() === 0) return;
            const iso = isoOf(h.year, h.month, h.day);
            os.delete(iso);
            if (!isSecondSaturday(h.year, h.month, h.day)) hs.add(iso);       // 2nd Saturdays are holidays by rule
        });
        P.overrides.forEach(h => {
            if (!o.months.has(h.mKey)) return;
            const iso = isoOf(h.year, h.month, h.day);
            hs.delete(iso);
            if (isSecondSaturday(h.year, h.month, h.day)) os.add(iso);
        });
        const after = new Set([...hs, ...[...os].map(x => 'o' + x)]);
        before.forEach(x => { if (!after.has(x)) st.holidays++; });
        after.forEach(x => { if (!before.has(x)) st.holidays++; });
        appData.holidays = [...hs].sort();
        appData.workingOverrides = [...os].sort();
    }

    const fi = document.getElementById('csvFileInput');
    if (fi) fi.value = '';
    closeImportModal();
    saveToStorage();
    renderPlanner();
    showUndoToast(`Import done: ${st.added + st.overwritten + st.merged} slot(s), ${st.perf} score/mark(s)${o.incH ? ', ' + st.holidays + ' holiday change(s)' : ''}.`);

    const notes = [];
    if (st.skipped) notes.push(`${st.skipped} slot(s) already had students and were kept as they were.`);
    if (st.perfSkipped) notes.push(`${st.perfSkipped} existing score / not-performed mark(s) were kept.`);
    if (st.notAssigned) notes.push(`${st.notAssigned} score(s) were skipped because that student is not assigned to the duty that day (import Assignments too).`);
    if (st.badDuties.size) notes.push('Duties not found, rows skipped: ' + [...st.badDuties].join(', '));
    if (st.newStudents.size) notes.push((o.addStudents ? 'Added to your Students list: ' : 'Not on your Students list (kept as archived): ') + [...st.newStudents].join(', '));
    if (notes.length) alert('Import finished.\n\n- ' + notes.join('\n- '));
}

function parseCSVDate(str) {
    if (!str) return null;
    str = str.trim();
    const months = { jan:0, feb:1, mar:2, apr:3, may:4, jun:5, jul:6, aug:7, sep:8, oct:9, nov:10, dec:11 };

    let m = str.match(/^(\d{1,2})-([A-Za-z]{3})-(\d{4})$/);
    if (m) {
        const mon = months[m[2].toLowerCase()];
        if (mon !== undefined) {
            return { year: parseInt(m[3]), month: mon, day: parseInt(m[1]), mKey: `${m[3]}-${String(mon+1).padStart(2,'0')}` };
        }
    }

    m = str.match(/^([A-Za-z]{3})\s+(\d{1,2}),\s*(\d{4})$/);
    if (m) {
        const mon = months[m[1].toLowerCase()];
        if (mon !== undefined) {
            return { year: parseInt(m[3]), month: mon, day: parseInt(m[2]), mKey: `${m[3]}-${String(mon+1).padStart(2,'0')}` };
        }
    }

    m = str.match(/^(\d{4})-(\d{2})-(\d{2})$/);
    if (m) {
        const year = parseInt(m[1]), month = parseInt(m[2]) - 1, day = parseInt(m[3]);
        return { year, month, day, mKey: `${year}-${String(month+1).padStart(2,'0')}` };
    }

    return null;
}

function findDutyIndex(name) {
    if (!name) return -1;
    const normalize = s => s.toLowerCase().replace(/&/g, 'and').replace(/\s+/g, ' ').trim();
    const target = normalize(name);

    let idx = appData.duties.findIndex(d => normalize(d.name) === target);
    if (idx !== -1) return idx;

    idx = appData.duties.findIndex(d => {
        const dn = normalize(d.name);
        return dn.includes(target) || target.includes(dn);
    });
    return idx;
}

/* ================= STUDENTS VIEW DASHBOARD =================
   A student x duty matrix with two view modes:
   - "Assignments": cell = how many times the student did that duty (+ absences)
   - "Performance": cell = average score out of 5 (+ absence count)
   Click a cell for the per-date breakdown. */

let studentsViewRange = 3;                       // months, or the string 'all'
let studentsViewMonths = [];                     // [{year, month, mKey}] in range, oldest first
let studentsViewStats = {};                      // name -> { dIdx -> { done:[Date], absent:[Date], ratings:[{d,score,remark}] } }
let svViewMode = 'counts';                       // 'counts' | 'perf'

let svFrom = null, svTo = null;                   // custom range bounds (Date at midnight) or null

function parseDateInput(v) {                       // "YYYY-MM-DD" -> local Date (no timezone shift)
    if (!v) return null;
    const [y, m, d] = v.split('-').map(Number);
    return new Date(y, m - 1, d);
}
function dateToInput(dt) { return isoOf(dt.getFullYear(), dt.getMonth(), dt.getDate()); }

function studentsViewRangeChanged() {
    const val = document.getElementById('studentsViewRange').value;
    studentsViewRange = (val === 'all' || val === 'custom') ? val : parseInt(val, 10);

    const box = document.getElementById('svCustomRange');
    if (box) box.classList.toggle('hidden', studentsViewRange !== 'custom');

    if (studentsViewRange === 'custom') {
        const fromEl = document.getElementById('svFromDate');
        const toEl = document.getElementById('svToDate');
        // First time: start with the current month so something sensible shows
        if (!fromEl.value || !toEl.value) {
            const t = new Date();
            fromEl.value = isoOf(t.getFullYear(), t.getMonth(), 1);
            toEl.value = dateToInput(new Date(t.getFullYear(), t.getMonth() + 1, 0));
        }
        svFrom = parseDateInput(fromEl.value);
        svTo = parseDateInput(toEl.value);
        if (svFrom && svTo && svFrom > svTo) {       // typed them the wrong way round - just swap
            [svFrom, svTo] = [svTo, svFrom];
            fromEl.value = dateToInput(svFrom);
            toEl.value = dateToInput(svTo);
        }
    }
    renderStudentsView();
}

function setSVViewMode(mode) {
    svViewMode = mode;
    const onCls = ['bg-white', 'shadow', 'text-brand-700'];
    const offCls = ['text-gray-500'];
    const c = document.getElementById('svToggleCounts');
    const p = document.getElementById('svTogglePerf');
    if (!c || !p) return;
    [c, p].forEach(b => b.classList.remove(...onCls, ...offCls));
    c.classList.add(...(mode === 'counts' ? onCls : offCls));
    p.classList.add(...(mode === 'perf' ? onCls : offCls));
    renderStudentsView();
}

function getStudentsViewMonths() {
    if (studentsViewRange === 'all') {
        return Object.keys(appData.assignments || {})
            .sort()
            .map(k => {
                const parts = k.split('-');
                return { year: parseInt(parts[0], 10), month: parseInt(parts[1], 10) - 1, mKey: k };
            });
    }
    const months = [];
    if (studentsViewRange === 'custom') {
        if (!svFrom || !svTo) {                       // dates not filled in yet: show nothing extra
            const t = new Date();
            return [{ year: t.getFullYear(), month: t.getMonth(), mKey: getMonthKey(t.getFullYear(), t.getMonth()) }];
        }
        let cy = svFrom.getFullYear(), cm = svFrom.getMonth();
        while (cy < svTo.getFullYear() || (cy === svTo.getFullYear() && cm <= svTo.getMonth())) {
            months.push({ year: cy, month: cm, mKey: getMonthKey(cy, cm) });
            cm++;
            if (cm > 11) { cm = 0; cy++; }
        }
        return months;
    }
    // Presets count back from the REAL current month (today), not from the month open in the planner
    const nowD = new Date();
    let y = nowD.getFullYear(), m = nowD.getMonth();
    for (let i = 0; i < studentsViewRange; i++) {
        months.push({ year: y, month: m, mKey: getMonthKey(y, m) });
        m--;
        if (m < 0) { m = 11; y--; }
    }
    return months.reverse();
}

// Walk every day in the range and tally done / absent / rated performances.
function collectStudentDutyStats(months) {
    const stats = {};                       // studentId -> dutyId -> { done, absent, ratings }
    appData.students.forEach(st => { stats[st.id] = {}; });
    // For a custom range only days between the two chosen dates (inclusive) are counted
    const useBounds = studentsViewRange === 'custom' && svFrom && svTo;
    const inRange = (dt) => !useBounds || (dt >= svFrom && dt <= svTo);
    const ensure = (sid, dutyId) => {
        if (!stats[sid]) stats[sid] = {};
        if (!stats[sid][dutyId]) stats[sid][dutyId] = { done: [], absent: [], ratings: [] };
        return stats[sid][dutyId];
    };

    months.forEach(({ year, month, mKey }) => {
        const amap = appData.assignments[mKey];
        if (!amap) return;
        const rmap = (appData.ratings || {})[mKey] || {};
        const xmap = (appData.absences || {})[mKey] || {};

        Object.keys(amap).forEach(dutyId => {
            const daysMap = amap[dutyId];
            if (!daysMap) return;
            Object.keys(daysMap).forEach(dayNumStr => {
                const dt = new Date(year, month, parseInt(dayNumStr, 10));
                if (!inRange(dt)) return;
                (daysMap[dayNumStr] || []).forEach(sid => ensure(sid, dutyId).done.push(dt));
            });
        });
        Object.keys(xmap).forEach(dutyId => {
            Object.keys(xmap[dutyId] || {}).forEach(dayNumStr => {
                const dt = new Date(year, month, parseInt(dayNumStr, 10));
                if (!inRange(dt)) return;
                (xmap[dutyId][dayNumStr] || []).forEach(sid => ensure(sid, dutyId).absent.push(dt));
            });
        });
        Object.keys(rmap).forEach(dutyId => {
            Object.keys(rmap[dutyId] || {}).forEach(dayNumStr => {
                const dt = new Date(year, month, parseInt(dayNumStr, 10));
                if (!inRange(dt)) return;
                const obj = rmap[dutyId][dayNumStr] || {};
                Object.keys(obj).forEach(sid => ensure(sid, dutyId).ratings.push({ d: dt, score: obj[sid].score, remark: obj[sid].remark || '' }));
            });
        });
    });

    Object.values(stats).forEach(dutyMap => {
        Object.values(dutyMap).forEach(c => {
            c.done.sort((a, b) => a - b);
            c.absent.sort((a, b) => a - b);
            c.ratings.sort((a, b) => a.d - b.d);
        });
    });
    return stats;
}

function svCellClass(count) {
    if (count >= 4) return 'bg-brand-500 text-white';
    if (count === 3) return 'bg-brand-500/70 text-white';
    if (count === 2) return 'bg-brand-100 text-brand-900';
    if (count === 1) return 'bg-brand-50 text-brand-900';
    return 'bg-white text-gray-300';
}

function svPerfClass(avg) {
    if (avg === null) return 'bg-white text-gray-300';
    if (avg >= 4) return 'bg-emerald-500 text-white';
    if (avg >= 3) return 'bg-emerald-100 text-emerald-900';
    if (avg >= 2) return 'bg-amber-100 text-amber-900';
    return 'bg-red-100 text-red-900';
}

function renderStudentsView() {
    studentsViewMonths = getStudentsViewMonths();
    studentsViewStats = collectStudentDutyStats(studentsViewMonths);
    renderFairnessSummary();

    const monthNames = ["January", "February", "March", "April", "May", "June", "July", "August", "September", "October", "November", "December"];
    let rangeLabel = 'No data yet';
    if (studentsViewRange === 'custom' && svFrom && svTo) {
        const f = dt => `${dt.getDate()} ${monthNames[dt.getMonth()].slice(0, 3)} ${dt.getFullYear()}`;
        rangeLabel = `${f(svFrom)} - ${f(svTo)}`;
    } else if (studentsViewMonths.length > 0) {
        const first = studentsViewMonths[0];
        const last = studentsViewMonths[studentsViewMonths.length - 1];
        rangeLabel = `${monthNames[first.month].slice(0, 3)} ${first.year} - ${monthNames[last.month].slice(0, 3)} ${last.year}`;
    }
    document.getElementById('svRangeLabel').textContent = rangeLabel;

    const perf = svViewMode === 'perf';

    const headerRow = document.getElementById('studentsViewHeaderRow');
    let h = `<th class="p-3 font-bold sv-corner bg-brand-100 border-r border-gray-200 w-52 min-w-[200px]">STUDENT / ${perf ? 'SCORE' : 'DUTY'}</th>`;
    appData.duties.forEach((duty) => {
        h += `<th class="p-3 font-semibold text-center min-w-[110px] border-r border-gray-200 sv-frozen-row bg-brand-100/95" title="${esc(duty.name)}"><span class="block truncate max-w-[130px] mx-auto">${esc(duty.name)}</span></th>`;
    });
    h += `<th class="p-3 font-bold text-center min-w-[90px] sv-frozen-row bg-brand-100/95 border-l-2 border-gray-300">${perf ? 'AVG' : 'TOTAL'}</th>`;
    headerRow.innerHTML = h;

    const tbody = document.getElementById('studentsViewBody');
    let body = '';
    appData.students.forEach((s, sIdx) => {
        const initials = s.name.split(' ').filter(Boolean).map(w => w[0]).slice(0, 2).join('').toUpperCase();
        const dutyMap = studentsViewStats[s.id] || {};
        const doneTotal = Object.values(dutyMap).reduce((sum, c) => sum + (c ? c.done.length : 0), 0);
        const allScores = [];
        Object.values(dutyMap).forEach(c => (c ? c.ratings : []).forEach(r => allScores.push(r.score)));
        const avgAll = allScores.length ? (allScores.reduce((a, b) => a + b, 0) / allScores.length) : null;

        body += `<tr class="hover:bg-gray-50/85 transition">`;
        body += `<td class="p-3 border-r border-gray-200 sv-frozen-col bg-white">
            <div class="flex items-center space-x-2">
                <span class="w-7 h-7 rounded-full bg-brand-100 text-brand-900 flex items-center justify-center text-[10px] font-bold shrink-0">${esc(initials)}</span>
                <div class="min-w-0"><p class="text-xs font-bold text-gray-900 truncate">${esc(s.name)}</p><p class="text-[10px] text-gray-400">${esc(s.class)}</p></div>
            </div></td>`;

        appData.duties.forEach((duty, dIdx) => {
            const dutyName = duty.name;
            const cell = dutyMap[duty.id] || { done: [], absent: [], ratings: [] };
            const absBadge = cell.absent.length
                ? `<span class="ml-1 inline-flex items-center justify-center min-w-[16px] h-4 px-1 rounded-full bg-red-500 text-white text-[9px] font-bold" title="${cell.absent.length} absent / did not perform">A${cell.absent.length}</span>`
                : '';

            if (!perf) {
                const count = cell.done.length;
                body += `<td class="p-2 border-r border-gray-100 text-center cursor-pointer transition hover:ring-2 hover:ring-inset hover:ring-brand-500/60 ${svCellClass(count)}"
                    onclick="openStudentDutyDetail(${sIdx}, ${dIdx})" title="${esc(s.name)} - ${esc(dutyName)}: ${count} time(s)">
                    <span class="inline-flex items-center justify-center min-h-[28px] rounded-lg text-xs font-bold px-1.5">${count > 0 ? count : '\u00b7'}${absBadge}</span></td>`;
            } else {
                const scores = cell.ratings.map(r => r.score);
                const n = scores.length;
                const avg = n ? (scores.reduce((a, b) => a + b, 0) / n) : null;
                const sub = cell.absent.length
                    ? `<span class="text-[9px] font-bold text-red-500">A${cell.absent.length}</span>`
                    : (n ? `<span class="text-[9px] opacity-70">n=${n}</span>` : '');
                body += `<td class="p-2 border-r border-gray-100 text-center cursor-pointer transition hover:ring-2 hover:ring-inset hover:ring-brand-500/60 ${svPerfClass(avg)}"
                    onclick="openStudentDutyDetail(${sIdx}, ${dIdx})" title="${esc(s.name)} - ${esc(dutyName)}${avg !== null ? ': avg ' + avg.toFixed(1) + '/5 across ' + n + ' rated performance(s)' : ': not rated yet'}">
                    <span class="inline-flex flex-col items-center justify-center min-h-[28px] rounded-lg text-xs font-bold px-1.5 leading-tight">${avg !== null ? avg.toFixed(1) : '\u00b7'}${sub}</span></td>`;
            }
        });

        if (!perf) {
            body += `<td class="p-2 text-center border-l-2 border-gray-300 bg-gray-50 font-bold text-xs text-gray-700">${doneTotal > 0 ? doneTotal : '\u2014'}</td>`;
        } else {
            body += `<td class="p-2 text-center border-l-2 border-gray-300 bg-gray-50 font-bold text-xs text-gray-700">${avgAll !== null ? avgAll.toFixed(1) : '\u2014'}</td>`;
        }
        body += `</tr>`;
    });
    tbody.innerHTML = body;
}

// Small stat cards above the matrix - the "fairness report"
function renderFairnessSummary() {
    const el = document.getElementById('svFairness');
    if (!el) return;
    if (!appData.students.length) { el.innerHTML = ''; return; }

    const perStudent = {};
    appData.students.forEach(s => { perStudent[s.id] = { done: 0, abs: 0, scores: [] }; });

    let scoreSum = 0, scoreCount = 0;
    Object.keys(studentsViewStats).forEach(sid => {
        if (!perStudent[sid]) return;
        Object.values(studentsViewStats[sid]).forEach(c => {
            perStudent[sid].done += c.done.length;
            perStudent[sid].abs += c.absent.length;
            c.ratings.forEach(r => { scoreSum += r.score; scoreCount++; perStudent[sid].scores.push(r.score); });
        });
    });

    const names = Object.keys(perStudent);
    const total = names.reduce((a, n) => a + perStudent[n].done, 0);
    const absTotal = names.reduce((a, n) => a + perStudent[n].abs, 0);
    const most = names.reduce((a, b) => perStudent[a].done >= perStudent[b].done ? a : b);
    const least = names.reduce((a, b) => perStudent[a].done <= perStudent[b].done ? a : b);
    const avgPer = names.length ? (total / names.length).toFixed(1) : '0';
    const avgScore = scoreCount ? (scoreSum / scoreCount).toFixed(1) : null;

    const card = (label, value, icon, color) => `
        <div class="bg-white p-3.5 rounded-2xl border border-gray-200 shadow-sm">
            <div class="flex items-center space-x-1.5 text-[10px] font-bold uppercase tracking-wider text-gray-400"><i class="fa-solid ${icon} ${color}"></i><span>${label}</span></div>
            <p class="text-sm font-bold text-gray-900 mt-1 truncate" title="${esc(String(value))}">${esc(String(value))}</p>
        </div>`;

    el.innerHTML =
        card('Total assignments', total, 'fa-calendar-check', 'text-brand-500') +
        card('Avg per student', avgPer, 'fa-divide', 'text-brand-500') +
        card('Most active', perStudent[most].done > 0 ? `${studentName(most)} (${perStudent[most].done})` : 'No data yet', 'fa-arrow-trend-up', 'text-emerald-500') +
        card('Least active', (total > 0 && perStudent[least].done < total / names.length) ? `${studentName(least)} (${perStudent[least].done})` : (total > 0 ? 'Balanced' : 'No data yet'), 'fa-arrow-trend-down', 'text-amber-500') +
        card('Avg score', avgScore !== null ? `${avgScore} / 5` : 'Not rated yet', 'fa-star', 'text-amber-500') +
        card('Absences', absTotal, 'fa-user-xmark', 'text-red-500');
}

function openStudentDutyDetail(studentIdx, dutyIdx) {
    const student = appData.students[studentIdx];
    if (!student) return;
    const duty = appData.duties[dutyIdx];
    const cell = ((studentsViewStats[student.id] || {})[duty ? duty.id : null]) || { done: [], absent: [], ratings: [] };

    document.getElementById('svModalStudent').textContent = student.name;
    document.getElementById('svModalDuty').textContent = (duty ? duty.name : '-');

    const shortMonths = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];
    const fmt = dObj => `${dObj.toLocaleDateString('en-US', { weekday: 'short' })}, ${dObj.getDate()} ${shortMonths[dObj.getMonth()]} ${dObj.getFullYear()}`;
    const ratingByDate = {};
    cell.ratings.forEach(r => { ratingByDate[r.d.getTime()] = r; });

    let html = '';
    if (svViewMode === 'perf') {
        document.getElementById('svModalCount').textContent = cell.ratings.length
            ? `avg ${(cell.ratings.reduce((a, r) => a + r.score, 0) / cell.ratings.length).toFixed(1)}/5 from ${cell.ratings.length} rated performance(s)`
            : 'not rated yet';
        if (cell.ratings.length) {
            html += `<div class="space-y-2">` + cell.ratings.map(r => `
                <div class="bg-gray-50 border border-gray-200 rounded-xl p-3 flex items-start justify-between space-x-3">
                    <div class="min-w-0">
                        <p class="text-xs font-bold text-gray-800"><i class="fa-regular fa-calendar mr-1.5 text-brand-500"></i>${fmt(r.d)}</p>
                        ${r.remark ? `<p class="text-[11px] text-gray-500 mt-1 italic">"${esc(r.remark)}"</p>` : ''}
                    </div>
                    <span class="text-amber-500 text-xs font-bold whitespace-nowrap">${'\u2605'.repeat(r.score)}<span class="text-gray-300">${'\u2606'.repeat(5 - r.score)}</span> <span class="text-gray-400">${r.score}/5</span></span>
                </div>`).join('') + `</div>`;
        } else {
            html += `<div class="text-xs text-gray-400 italic p-2">No performance ratings for this duty in the selected range.</div>`;
        }
        if (cell.absent.length) {
            html += `<p class="text-[10px] font-bold text-red-500 uppercase tracking-wider mt-4 mb-1.5">Absent / did not perform</p><div class="flex flex-wrap">` +
                cell.absent.map(dObj => `<span class="inline-flex items-center bg-red-50 border border-red-200 text-red-600 px-2.5 py-1 rounded-lg text-xs font-medium mr-1.5 mb-1.5"><i class="fa-solid fa-user-xmark mr-1.5"></i>${fmt(dObj)}</span>`).join('') + `</div>`;
        }
    } else {
        document.getElementById('svModalCount').textContent = `${cell.done.length} time(s), ${cell.absent.length} absent`;
        if (cell.done.length) {
            html += `<div class="flex flex-wrap mb-1">` + cell.done.map(dObj => {
                const r = ratingByDate[dObj.getTime()];
                return `<span class="inline-flex items-center bg-brand-50 border border-brand-100 text-brand-900 px-2.5 py-1 rounded-lg text-xs font-medium mr-1.5 mb-1.5" title="${r ? 'Rated ' + r.score + '/5' : 'Not rated'}"><i class="fa-regular fa-calendar mr-1.5 text-brand-500"></i>${fmt(dObj)}${r ? ` <span class="text-amber-500 ml-1">${'\u2605'.repeat(r.score)}</span>` : ''}</span>`;
            }).join('') + `</div>`;
        }
        if (cell.absent.length) {
            html += `<p class="text-[10px] font-bold text-red-500 uppercase tracking-wider mt-3 mb-1.5">Absent / did not perform</p><div class="flex flex-wrap">` +
                cell.absent.map(dObj => `<span class="inline-flex items-center bg-red-50 border border-red-200 text-red-600 px-2.5 py-1 rounded-lg text-xs font-medium mr-1.5 mb-1.5"><i class="fa-solid fa-user-xmark mr-1.5"></i>${fmt(dObj)}</span>`).join('') + `</div>`;
        }
        if (!cell.done.length && !cell.absent.length) {
            html = `<div class="text-xs text-gray-400 italic p-2">Not assigned to this duty in the selected range.</div>`;
        }
    }
    document.getElementById('svModalDateList').innerHTML = html;
    document.getElementById('studentDutyModal').classList.remove('hidden');
}

function closeStudentDutyModal() {
    document.getElementById('studentDutyModal').classList.add('hidden');
}

/* ================= SMART ASSIGN =================
   pickBestStudent: the fairest pick for a duty on a given day =
   fewest past turns on THIS duty (last 3 months) * 10
 + fewest assignments this month * 3
 + huge penalty if already on duty that same day. */

function getDutyCountsLastMonths(dutyId, monthsBack) {
    const counts = {};
    let y = currentYear, m = currentMonth;
    for (let i = 0; i < monthsBack; i++) {
        const mk = getMonthKey(y, m);
        const cell = ((appData.assignments || {})[mk] || {})[dutyId] || {};
        Object.keys(cell).forEach(day => (cell[day] || []).forEach(n => { if (wasAbsent(mk, dutyId, day, n)) return; counts[n] = (counts[n] || 0) + 1; }));
        m--;
        if (m < 0) { m = 11; y--; }
    }
    return counts;
}

function pickBestStudent(dutyId, year, month, day, excludeIds) {
    const dutyCounts = getDutyCountsLastMonths(dutyId, 3);
    const mk = getMonthKey(year, month);
    const monthMap = (appData.assignments || {})[mk] || {};
    const monthCounts = {};
    Object.keys(monthMap).forEach(dId => Object.keys(monthMap[dId] || {}).forEach(dy => ((monthMap[dId] || {})[dy] || []).forEach(n => { if (wasAbsent(mk, dId, dy, n)) return; monthCounts[n] = (monthCounts[n] || 0) + 1; })));
    const sameDay = new Set();
    appData.duties.forEach(d => {
        ((monthMap[d.id] || {})[day] || []).forEach(n => { if (!wasAbsent(mk, d.id, day, n)) sameDay.add(n); });
    });

    let best = null, bestScore = Infinity;
    appData.students.forEach(s => {
        if (excludeIds.includes(s.id)) return;
        const score = (dutyCounts[s.id] || 0) * 10 + (monthCounts[s.id] || 0) * 3 + (sameDay.has(s.id) ? 100 : 0);
        if (score < bestScore) { bestScore = score; best = s.id; }
    });
    return best;
}

/* One-click: fill every empty slot of the current month with a balanced pick.
   Skips Sundays and holidays; never overwrites anything already assigned. */
function autoFillMonth() {
    if (!appData.students.length) { alert("Add students in the Students tab first."); return; }
    const monthNames = ["January", "February", "March", "April", "May", "June", "July", "August", "September", "October", "November", "December"];
    if (!confirm(`Smart-fill all empty slots for ${monthNames[currentMonth]} ${currentYear}?\n\nExisting assignments are kept. One student per empty slot, balanced by past duty history.`)) return;

    ensureMonthAssignments(currentYear, currentMonth);
    lastStateBackup = JSON.parse(JSON.stringify(appData));
    const mKey = getMonthKey(currentYear, currentMonth);
    const days = getWorkingDaysForMonth(currentYear, currentMonth)
        .filter(d => !isHolidayDate(d.getFullYear(), d.getMonth(), d.getDate()));

    let filled = 0;
    days.forEach(dObj => {
        const dayNum = dObj.getDate();
        appData.duties.forEach(duty => {
            const existing = ((appData.assignments[mKey][duty.id] || {})[dayNum]) || [];
            if (existing.length > 0) return;
            const exclude = [];
            appData.duties.forEach(other => {
                exclude.push(...(((appData.assignments[mKey][other.id] || {})[dayNum]) || []));
            });
            const pickN = pickBestStudent(duty.id, currentYear, currentMonth, dayNum, exclude);
            if (!pickN) return;
            if (!appData.assignments[mKey][duty.id]) appData.assignments[mKey][duty.id] = {};
            appData.assignments[mKey][duty.id][dayNum] = [pickN];
            filled++;
        });
    });

    saveToStorage();
    renderPlanner();
    showUndoToast(filled > 0 ? `Smart-filled ${filled} empty slot(s).` : 'Nothing to fill - every slot already has students.');
}

/* ================= HOLIDAYS =================
   A full-month calendar. Click days to mark / unmark them (several at once),
   then press "Save holidays". Sundays can't be selected. The 2nd Saturday of
   every month is a holiday by default - click it to make it a working day.
   Changes are held in a draft until Save, so Cancel throws them away. */

let holCalYear = new Date().getFullYear();
let holCalMonth = new Date().getMonth();
let holDraft = { holidays: new Set(), overrides: new Set() };

// Is this date a holiday according to a draft (same rule as isHolidayDate)?
function draftIsHoliday(draft, y, m, d) {
    const iso = isoOf(y, m, d);
    if (draft.overrides.has(iso)) return false;
    return draft.holidays.has(iso) || isSecondSaturday(y, m, d);
}

// Click on a day: flip it between holiday and working day (inside the draft)
function toggleDraftDay(draft, y, m, d) {
    if (new Date(y, m, d).getDay() === 0) return;        // Sundays can't be changed
    const iso = isoOf(y, m, d);
    if (draftIsHoliday(draft, y, m, d)) {
        draft.holidays.delete(iso);                       // -> working day
        if (isSecondSaturday(y, m, d)) draft.overrides.add(iso);
    } else {
        draft.overrides.delete(iso);                      // -> holiday
        draft.holidays.add(iso);
    }
}

function openHolidaysModal() {
    holDraft = {
        holidays: new Set(appData.holidays || []),
        overrides: new Set(appData.workingOverrides || [])
    };
    holCalYear = currentYear;
    holCalMonth = currentMonth;
    renderHolidayCalendar();
    document.getElementById('holidaysModal').classList.remove('hidden');
}

// Close WITHOUT saving
function closeHolidaysModal() {
    document.getElementById('holidaysModal').classList.add('hidden');
}

function changeHolidayMonth(direction) {
    holCalMonth += direction;
    if (holCalMonth > 11) { holCalMonth = 0; holCalYear++; }
    else if (holCalMonth < 0) { holCalMonth = 11; holCalYear--; }
    renderHolidayCalendar();
}

function toggleHolidayDay(day) {
    toggleDraftDay(holDraft, holCalYear, holCalMonth, day);
    renderHolidayCalendar();
}

function renderHolidayCalendar() {
    const monthNames = ["January", "February", "March", "April", "May", "June", "July", "August", "September", "October", "November", "December"];
    document.getElementById('holidayMonthLabel').textContent = `${monthNames[holCalMonth]} ${holCalYear}`;

    const daysInMonth = new Date(holCalYear, holCalMonth + 1, 0).getDate();
    const lead = (new Date(holCalYear, holCalMonth, 1).getDay() + 6) % 7;   // Monday-first grid
    const now = new Date();
    let html = '';
    for (let i = 0; i < lead; i++) html += '<div></div>';

    const marked = [];
    for (let d = 1; d <= daysInMonth; d++) {
        const isSun = new Date(holCalYear, holCalMonth, d).getDay() === 0;
        const second = isSecondSaturday(holCalYear, holCalMonth, d);
        const hol = !isSun && draftIsHoliday(holDraft, holCalYear, holCalMonth, d);
        const isToday = d === now.getDate() && holCalMonth === now.getMonth() && holCalYear === now.getFullYear();
        if (hol) marked.push(d);

        if (isSun) {
            html += `<div class="aspect-square rounded-xl bg-gray-100 text-gray-300 flex items-center justify-center text-xs sm:text-sm font-semibold select-none" title="Sunday - always off">${d}</div>`;
            continue;
        }
        let label = '';
        if (hol) label = second && !holDraft.holidays.has(isoOf(holCalYear, holCalMonth, d)) ? '2nd Sat' : 'Off';
        else if (second) label = 'Open';
        const cls = hol
            ? 'bg-red-500 text-white border-red-500 shadow-sm'
            : 'bg-white text-gray-800 border-gray-200 hover:bg-brand-50 hover:border-brand-500';
        html += `<button type="button" onclick="toggleHolidayDay(${d})" aria-pressed="${hol}" aria-label="${d} ${monthNames[holCalMonth]}${hol ? ', holiday' : ''}"
            class="aspect-square rounded-xl border flex flex-col items-center justify-center leading-none transition focus:outline-none focus:ring-2 focus:ring-brand-500 ${cls} ${isToday ? 'ring-2 ring-brand-500' : ''}">
            <span class="text-xs sm:text-sm font-bold">${d}</span>
            <span class="text-[8px] sm:text-[9px] font-semibold mt-0.5 h-2 ${hol ? 'text-red-100' : 'text-gray-400'}">${label}</span>
        </button>`;
    }
    document.getElementById('holidayCalendar').innerHTML = html;

    document.getElementById('holidaySummary').textContent = marked.length
        ? `${marked.length} holiday${marked.length > 1 ? 's' : ''} in ${monthNames[holCalMonth]}: ${marked.join(', ')}`
        : `No holidays in ${monthNames[holCalMonth]}.`;
}

// Save: write the draft into the real data, then (optionally) move duties off the NEW holidays
function saveHolidays() {
    const oldHol = (y, m, d) => isHolidayDate(y, m, d);            // uses the data as it is right now
    const candidates = new Set([...holDraft.holidays, ...(appData.workingOverrides || [])]);

    const newlyHoliday = [];
    candidates.forEach(iso => {
        const [y, m, d] = iso.split('-').map(Number);
        if (new Date(y, m - 1, d).getDay() === 0) return;
        if (!oldHol(y, m - 1, d) && draftIsHoliday(holDraft, y, m - 1, d)) newlyHoliday.push(iso);
    });
    newlyHoliday.sort();

    const nextHolidays = [...holDraft.holidays].sort();
    const nextOverrides = [...holDraft.overrides].sort();
    const unchanged = JSON.stringify(nextHolidays) === JSON.stringify([...(appData.holidays || [])].sort())
        && JSON.stringify(nextOverrides) === JSON.stringify([...(appData.workingOverrides || [])].sort());
    if (unchanged) { closeHolidaysModal(); return; }

    lastStateBackup = JSON.parse(JSON.stringify(appData));         // so Undo works
    appData.holidays = nextHolidays;
    appData.workingOverrides = nextOverrides;

    let moved = 0;
    if (document.getElementById('holidayShiftChk').checked) {
        newlyHoliday.forEach(iso => {
            const [y, m, d] = iso.split('-').map(Number);
            moved += shiftDayDuties(y, m - 1, d);
        });
    }

    closeHolidaysModal();
    saveToStorage();
    renderPlanner();
    showUndoToast(moved > 0 ? `Holidays saved - ${moved} assignment(s) moved to the next working day.` : 'Holidays saved.');
}

/* Move every assignment / rating / absence of the given day to the next
   working day (skipping Sundays and other holidays). Existing entries on
   the target day are merged (names de-duplicated). */
function shiftDayDuties(y, m, d) {
    const mKey = getMonthKey(y, m);
    const amap = (appData.assignments || {})[mKey];
    if (!amap) return 0;

    const t = nextWorkingDayAfter(y, m, d);
    const tKey = getMonthKey(t.getFullYear(), t.getMonth());
    const tDay = t.getDate();
    if (!appData.assignments[tKey]) appData.assignments[tKey] = {};
    if (!appData.ratings[tKey]) appData.ratings[tKey] = {};
    if (!appData.absences[tKey]) appData.absences[tKey] = {};

    let moved = 0;
    appData.duties.forEach(duty => {
        const dKey = duty.id;
        const srcNames = ((amap[dKey] || {})[d]) || [];
        const srcRatings = (((appData.ratings[mKey] || {})[dKey]) || {})[d] || {};
        const srcAbsent = (((appData.absences[mKey] || {})[dKey]) || {})[d] || [];
        if (!srcNames.length && !Object.keys(srcRatings).length && !srcAbsent.length) return;

        if (!appData.assignments[tKey][dKey]) appData.assignments[tKey][dKey] = {};
        const target = appData.assignments[tKey][dKey][tDay] || [];
        srcNames.forEach(n => { if (!target.includes(n)) target.push(n); });
        appData.assignments[tKey][dKey][tDay] = target;

        if (Object.keys(srcRatings).length) {
            if (!appData.ratings[tKey][dKey]) appData.ratings[tKey][dKey] = {};
            appData.ratings[tKey][dKey][tDay] = Object.assign({}, ((appData.ratings[tKey][dKey] || {})[tDay]) || {}, srcRatings);
        }
        if (srcAbsent.length) {
            if (!appData.absences[tKey][dKey]) appData.absences[tKey][dKey] = {};
            const tAbs = appData.absences[tKey][dKey][tDay] || [];
            srcAbsent.forEach(n => { if (!tAbs.includes(n)) tAbs.push(n); });
            appData.absences[tKey][dKey][tDay] = tAbs;
        }

        delete amap[dKey][d];
        if (appData.ratings[mKey] && appData.ratings[mKey][dKey]) delete appData.ratings[mKey][dKey][d];
        if (appData.absences[mKey] && appData.absences[mKey][dKey]) delete appData.absences[mKey][dKey][d];
        moved += srcNames.length;
    });
    return moved;
}

/* ================= SWAP TWO STUDENTS ================= */

function openSwapModal() {
    const opts = appData.students.map(s => `<option value="${esc(s.id)}">${esc(s.name)} (${esc(s.class)})</option>`).join('');
    document.getElementById('swapStudentA').innerHTML = opts;
    document.getElementById('swapStudentB').innerHTML = opts;
    document.getElementById('swapModal').classList.remove('hidden');
}

function closeSwapModal() {
    document.getElementById('swapModal').classList.add('hidden');
}

function executeSwap() {
    const a = document.getElementById('swapStudentA').value;
    const b = document.getElementById('swapStudentB').value;
    if (!a || !b || a === b) { alert('Pick two different students.'); return; }
    const scope = document.getElementById('swapScope').value;
    const mKeys = scope === 'month' ? [getMonthKey(currentYear, currentMonth)] : Object.keys(appData.assignments || {});
    lastStateBackup = JSON.parse(JSON.stringify(appData));

    const swapName = n => (n === a ? b : (n === b ? a : n));
    let swaps = 0;
    mKeys.forEach(mk => {
        const amap = appData.assignments[mk];
        if (amap) Object.keys(amap).forEach(dIdx => {
            Object.keys(amap[dIdx]).forEach(day => {
                const list = amap[dIdx][day] || [];
                if (list.includes(a) || list.includes(b)) { amap[dIdx][day] = list.map(swapName); swaps++; }
            });
        });
        const xmap = (appData.absences || {})[mk];
        if (xmap) Object.keys(xmap).forEach(dIdx => {
            Object.keys(xmap[dIdx]).forEach(day => {
                const l = xmap[dIdx][day] || [];
                if (l.includes(a) || l.includes(b)) xmap[dIdx][day] = l.map(swapName);
            });
        });
        const rmap = (appData.ratings || {})[mk];
        if (rmap) Object.keys(rmap).forEach(dIdx => {
            Object.keys(rmap[dIdx]).forEach(day => {
                const o = rmap[dIdx][day] || {};
                if (o[a] || o[b]) {
                    const nObj = {};
                    Object.keys(o).forEach(k => { nObj[swapName(k)] = o[k]; });
                    rmap[dIdx][day] = nObj;
                }
            });
        });
    });

    closeSwapModal();
    saveToStorage();
    if (!document.getElementById('tab-students').classList.contains('hidden')) renderStudentsTab();
    renderPlanner();
    showUndoToast(`Swapped ${studentName(a)} and ${studentName(b)} (${swaps} slot(s) affected). Undo is available.`);
}

/* ================= TODAY'S ASSEMBLY (announcement view) ================= */

function openTodayView() {
    const now = new Date();
    const y = now.getFullYear(), m = now.getMonth(), d = now.getDate();
    document.getElementById('todayDateTitle').textContent = now.toLocaleDateString('en-US', { weekday: 'long', month: 'long', day: 'numeric', year: 'numeric' });

    const body = document.getElementById('todayDutyList');
    if (now.getDay() === 0) {
        body.innerHTML = `<div class="text-center py-12 text-gray-400"><i class="fa-solid fa-bed text-4xl mb-3 block"></i><p class="font-bold">No assembly today - it is Sunday.</p></div>`;
    } else if (isHolidayDate(y, m, d)) {
        body.innerHTML = `<div class="text-center py-12 text-red-400"><i class="fa-solid fa-umbrella-beach text-4xl mb-3 block"></i><p class="font-bold">Holiday today - no assembly.</p></div>`;
    } else {
        const mKey = getMonthKey(y, m);
        let html = '';
        appData.duties.forEach((duty, dIdx) => {
            const names = ((appData.assignments[mKey] || {})[duty.id] || {})[d] || [];
            const absents = (((appData.absences[mKey] || {})[duty.id]) || {})[d] || [];
            html += `<div class="flex items-start justify-between py-3 border-b border-gray-100 last:border-0 gap-4">
                <span class="font-bold text-gray-800 text-sm md:w-1/3">${esc(duty.name)}</span>
                <div class="flex flex-wrap justify-end gap-1.5 md:w-2/3">${
                    names.length
                        ? names.map(n => `<span class="px-3 py-1.5 rounded-full text-xs font-bold ${absents.includes(n) ? 'bg-red-100 text-red-600 line-through' : 'bg-brand-100 text-brand-900'}">${esc(studentName(n))}</span>`).join('')
                        : '<span class="text-xs text-gray-300 italic py-1.5">Not assigned</span>'
                }</div></div>`;
        });
        body.innerHTML = html;
    }
    document.getElementById('todayViewModal').classList.remove('hidden');
}

function closeTodayView() {
    document.getElementById('todayViewModal').classList.add('hidden');
}

function printToday() {
    document.body.classList.add('printing-today');
    window.print();
    setTimeout(() => document.body.classList.remove('printing-today'), 600);
}

/* ================= INSIGHTS (charts) ================= */

let insightsCharts = [];

function computeAllTimeStats() {
    const perStudent = {}, scoreSum = {}, scoreCnt = {}, perDuty = {};
    appData.students.forEach(s => { perStudent[s.id] = 0; scoreSum[s.id] = 0; scoreCnt[s.id] = 0; });
    appData.duties.forEach(d => { perDuty[d.id] = 0; });

    Object.keys(appData.assignments || {}).forEach(mk => {
        const amap = appData.assignments[mk];
        if (!amap) return;
        Object.keys(amap).forEach(dutyId => {
            Object.values(amap[dutyId] || {}).forEach(list => (list || []).forEach(sid => {
                if (perStudent[sid] !== undefined) perStudent[sid]++;
                if (perDuty[dutyId] !== undefined) perDuty[dutyId]++;
            }));
        });
    });
    Object.keys(appData.ratings || {}).forEach(mk => {
        const rmap = appData.ratings[mk];
        if (!rmap) return;
        Object.values(rmap).forEach(daysMap => Object.values(daysMap || {}).forEach(obj => {
            Object.keys(obj || {}).forEach(sid => {
                if (scoreSum[sid] !== undefined) { scoreSum[sid] += obj[sid].score; scoreCnt[sid]++; }
            });
        }));
    });
    return { perStudent, perDuty, scoreSum, scoreCnt };
}

function mkBar(canvasId, labels, data, yMax) {
    const ctx = document.getElementById(canvasId);
    if (!ctx || !window.Chart) return;
    insightsCharts.push(new Chart(ctx, {
        type: 'bar',
        data: { labels, datasets: [{ data, backgroundColor: '#d99b26cc', borderRadius: 6, maxBarThickness: 46 }] },
        options: {
            responsive: true,
            maintainAspectRatio: false,
            plugins: { legend: { display: false } },
            scales: {
                y: { beginAtZero: true, ...(yMax ? { max: yMax } : {}), ticks: { precision: 0 } },
                x: { ticks: { autoSkip: false, font: { size: 10 } } }
            }
        }
    }));
}

function renderInsights() {
    insightsCharts.forEach(c => c.destroy());
    insightsCharts = [];

    if (!window.Chart) {
        document.getElementById('insightsNoChart').classList.remove('hidden');
        return;
    }
    document.getElementById('insightsNoChart').classList.add('hidden');

    const stats = computeAllTimeStats();
    const ids = appData.students.map(s => s.id);
    const names = appData.students.map(s => s.name);
    const ratedIdx = ids.map((id, i) => i).filter(i => stats.scoreCnt[ids[i]] > 0);
    const ratedNames = ratedIdx.map(i => names[i]);
    const avgScores = ratedIdx.map(i => +(stats.scoreSum[ids[i]] / stats.scoreCnt[ids[i]]).toFixed(2));

    mkBar('chartPerStudent', names, ids.map(id => stats.perStudent[id] || 0));
    mkBar('chartPerDuty', appData.duties.map(d => d.name), appData.duties.map(d => stats.perDuty[d.id] || 0));
    mkBar('chartAvgScore', ratedNames.length ? ratedNames : ['No ratings yet'], ratedNames.length ? avgScores : [0], 5);
}

/* ================= PROFILES (PIN-locked, one per teacher) =================
   - Profiles, PIN hashes, the master PIN and the GitHub token live ONLY on the
     secure server. This file never contains a secret.
   - The default profile keeps using data.json, so all existing data is kept.
     Every other profile uses profiles/<id>.json and starts with the default
     duties and an empty student list.
   - Login, profile creation and all PIN checks happen on the server. */

const DEFAULT_PROFILE_ID = "anmolvirk";
const PROFILES_FILE = "profiles.json";
const DEFAULT_PROFILE = {
    id: "anmolvirk", name: "Anmol Virk", cls: "6", section: "R",
    dataFile: "data.json", admin: true, createdAt: 0
};

let currentProfile = null;
let profilesList = [Object.assign({}, DEFAULT_PROFILE)];
let profilesReady = Promise.resolve();
let profilesState = 'loading';          // 'loading' | 'online' | 'offline'
let savePending = false;                // a save is waiting to be pushed to the cloud
let lockResolve = null;
let lockViewProfileId = DEFAULT_PROFILE_ID;
let lockView = 'pin';                   // 'pin' | 'chooser' | 'create'
let lockIdTouched = false;

function ghUrl(path) { return `${API_BASE}/file/${path}`; }   // data files go through the secure server, never straight to GitHub
function activeProfiles() { return profilesList.filter(p => !p.archived); }   // archived profiles cannot log in and are hidden from the login screen
function isDefaultProfile(p) { return !!p && p.id === DEFAULT_PROFILE_ID; }
function localKey() {
    return currentProfile && !isDefaultProfile(currentProfile) ? 'pdp_data_' + currentProfile.id : 'pdp_morning_assembly_data';
}
function backupKey() {
    return currentProfile && !isDefaultProfile(currentProfile) ? 'pdp_backup_' + currentProfile.id : 'pdp_backup_before_name_fix';
}
function freshProfileData() {
    return { schemaVersion: SCHEMA_VERSION, duties: makeDefaultDuties(), students: [], formerStudents: [], assignments: {}, absences: {}, ratings: {}, holidays: [], updatedAt: 0 };
}
function classLabel(p) {
    if (!p) return '';
    const c = String(p.cls || '').trim(), sec = String(p.section || '').trim();
    if (!c && !sec) return '';
    return (c ? (/^class\b/i.test(c) ? c : 'Class ' + c) : '') + sec;
}
function initialsOf(name) {
    const parts = String(name || '').trim().split(/\s+/).filter(Boolean);
    if (!parts.length) return '?';
    return (parts.length === 1 ? parts[0].slice(0, 2) : parts[0][0] + parts[parts.length - 1][0]).toUpperCase();
}
function netMsg(err) {
    const m = (err && err.message) || 'Something went wrong';
    return /fetch|network|load failed/i.test(m) ? 'Could not reach the cloud - check your internet connection and try again.' : m;
}

/* ---------- Secure server connection ---------- */
let sessionToken = null;
try { sessionToken = sessionStorage.getItem('pdp_token'); } catch (e) {}
function clearSession() { sessionToken = null; try { sessionStorage.removeItem('pdp_token'); sessionStorage.removeItem('pdp_session_profile'); } catch (e) {} }

async function api(path, opts = {}) {
    const headers = { 'Content-Type': 'application/json' };
    if (sessionToken) headers.Authorization = 'Bearer ' + sessionToken;
    let res;
    if (opts.body) opts = Object.assign({}, opts, { body: Object.assign({ did: sgDeviceId() }, opts.body) });   // tells the server which device this is
    try {
        res = await fetch(API_BASE + path, { method: opts.body ? 'POST' : 'GET', headers, body: opts.body ? JSON.stringify(opts.body) : undefined, cache: 'no-store' });
    } catch (e) { const er = new Error('Could not reach the cloud - check your internet connection and try again.'); er.network = true; throw er; }
    let j = {};
    try { j = await res.json(); } catch (e) {}
    if (!res.ok) { const er = new Error(j.error || ('Server error (' + res.status + ')')); er.status = res.status; er.code = j.code; er.other = j.other; throw er; }
    return j;
}
function validPin(pin) { return /^\d{4,8}$/.test(pin); }

/* ---------- Profile list (public details only - no PINs or hashes ever reach the browser) ---------- */
function withDefault(list) {
    const l = (Array.isArray(list) ? list : []).filter(p => p && p.id).map(p => ({ id: p.id, name: p.name, cls: p.cls || '', section: p.section || '', admin: !!p.admin, dataFile: p.dataFile, archived: !!p.archived, archivedAt: p.archivedAt || 0 }));
    if (!l.some(p => p.id === DEFAULT_PROFILE_ID)) l.unshift(Object.assign({}, DEFAULT_PROFILE));
    l.forEach(p => { if (p.id === DEFAULT_PROFILE_ID) { p.archived = false; } });
    return l;
}
function cacheProfiles() {
    try { localStorage.setItem('pdp_profiles_cache2', JSON.stringify({ profiles: activeProfiles().map(p => ({ id: p.id, name: p.name, cls: p.cls, section: p.section })) })); } catch (e) {}
}
(function initProfilesFromCache() {
    try {
        localStorage.removeItem('pdp_profiles_cache');          // old cache used to hold PIN hashes
        const c = JSON.parse(localStorage.getItem('pdp_profiles_cache2'));
        if (c && Array.isArray(c.profiles)) profilesList = withDefault(c.profiles);
    } catch (e) {}
})();

// The admin sees every profile (incl. archived); everyone else sees the active ones
async function refreshProfiles() {
    const r = await api(currentProfile && currentProfile.admin ? '/admin/profiles' : '/profiles');
    profilesList = withDefault(r.profiles);
    cacheProfiles();
}
async function loadProfiles() {
    profilesState = 'loading';
    try {
        const r = await api('/profiles');
        profilesList = withDefault(r.profiles);
        cacheProfiles();
        profilesState = 'online';
    } catch (err) {
        console.error('Profiles load failed:', err);
        profilesState = 'offline';
    }
    setLockStatus();
    if (lockView === 'chooser' && lockResolve) renderLockChooser();
}

// Writes a JSON file (own data / own backup only) through the secure server
async function putJsonFile(path, obj, message) {
    const res = await fetch(ghUrl(path), { headers: githubHeaders(), cache: 'no-store' });
    const body = { message, content: b64encode(JSON.stringify(obj)) };
    if (res.ok) body.sha = (await res.json()).sha;
    const put = await fetch(ghUrl(path), {
        method: 'PUT', headers: Object.assign({ 'Content-Type': 'application/json' }, githubHeaders()), body: JSON.stringify(body)
    });
    if (!put.ok) throw new Error('status ' + put.status);
}

/* ---------- Login / lock screen ---------- */
function lockHeaderHTML() {
    return `<div class="flex items-center justify-center space-x-3 mb-6">
        <div class="w-10 h-10 rounded-xl bg-brand-500 flex items-center justify-center text-white font-bold text-lg shadow-md"><i class="fa-solid fa-clipboard-user"></i></div>
        <div class="text-left"><h1 class="font-bold text-lg leading-tight text-brand-900">PDP</h1><p class="text-xs text-gray-400">DUTY PLANNER</p></div>
    </div>`;
}
function setLockStatus() {
    const el = document.getElementById('lockStatus');
    if (!el) return;
    el.textContent = profilesState === 'loading' ? 'Connecting to cloud...'
        : profilesState === 'online' ? 'Connected to secure cloud' : 'Cannot reach server - login needs internet';
}
function showLockError(msg) {
    const el = document.getElementById('lockError');
    if (el) el.textContent = msg || '';
}
function pinFailInfo(id) {
    try { return JSON.parse(localStorage.getItem('pdp_pin_fail_' + id)) || { count: 0, until: 0 }; } catch (e) { return { count: 0, until: 0 }; }
}
function setPinFailInfo(id, o) { try { localStorage.setItem('pdp_pin_fail_' + id, JSON.stringify(o)); } catch (e) {} }

function renderLockPin() {
    lockView = 'pin';
    const p = profilesList.find(x => x.id === lockViewProfileId) || profilesList[0];
    lockViewProfileId = p.id;
    document.getElementById('lockCard').innerHTML = `${lockHeaderHTML()}
        <div class="text-center">
            <div class="w-16 h-16 mx-auto rounded-full bg-brand-100 text-brand-900 flex items-center justify-center font-bold text-xl border border-brand-500/30">${esc(initialsOf(p.name))}</div>
            <h2 class="mt-3 text-lg font-bold text-gray-900">${esc(p.name)}</h2>
            <p class="text-xs text-gray-500">${esc(classLabel(p) || 'PDP Incharge')} &bull; @${esc(p.id)}</p>
        </div>
        <input id="lockPin" type="password" inputmode="numeric" pattern="[0-9]*" autocomplete="current-password" maxlength="8" placeholder="Enter PIN"
            oninput="this.value=this.value.replace(/\\D/g,'')" onkeydown="if(event.key==='Enter')submitPin()"
            class="w-full mt-5 text-center tracking-[0.4em] text-lg border border-gray-300 rounded-xl p-3 focus:outline-none focus:ring-2 focus:ring-brand-500">
        <p id="lockError" class="text-xs text-red-500 font-semibold text-center mt-2 min-h-[16px]"></p>
        <button id="lockUnlockBtn" onclick="submitPin()" class="w-full mt-3 bg-brand-500 hover:bg-brand-600 text-white py-3 rounded-xl font-semibold text-sm transition shadow">Unlock</button>
        <div class="flex items-center justify-between mt-4 text-xs">
            <button onclick="renderLockChooser()" class="text-brand-600 hover:text-brand-900 font-semibold"><i class="fa-solid fa-right-left mr-1"></i>Switch profile</button>
            <button onclick="renderLockCreate()" class="text-gray-500 hover:text-gray-800 font-semibold"><i class="fa-solid fa-plus mr-1"></i>New profile</button>
        </div>`;
    setLockStatus();
    setTimeout(() => { const i = document.getElementById('lockPin'); if (i) i.focus(); }, 50);
}

function renderLockChooser() {
    lockView = 'chooser';
    document.getElementById('lockCard').innerHTML = `${lockHeaderHTML()}
        <h2 class="text-center font-bold text-gray-900">Choose a profile</h2>
        <div class="space-y-2 mt-4 max-h-[50vh] overflow-y-auto">
            ${activeProfiles().map((p, i) => `
            <button onclick="lockPickProfile(${i})" class="w-full flex items-center space-x-3 p-3 rounded-2xl border border-gray-200 bg-gray-50 hover:bg-brand-50 hover:border-brand-500 transition text-left">
                <div class="w-10 h-10 rounded-full bg-brand-100 text-brand-900 flex items-center justify-center font-bold text-sm border border-brand-500/30 shrink-0">${esc(initialsOf(p.name))}</div>
                <div class="min-w-0 flex-1"><p class="text-sm font-bold text-gray-900 truncate">${esc(p.name)}</p><p class="text-xs text-gray-500 truncate">${esc(classLabel(p) || 'PDP Incharge')} &bull; @${esc(p.id)}</p></div>
                <i class="fa-solid fa-chevron-right text-gray-300 text-xs"></i>
            </button>`).join('')}
        </div>
        <button onclick="renderLockCreate()" class="w-full mt-4 border border-gray-300 hover:bg-gray-50 text-gray-700 py-3 rounded-xl text-sm font-semibold transition"><i class="fa-solid fa-plus text-brand-500 mr-2"></i>Create new profile</button>`;
    setLockStatus();
}
function lockPickProfile(i) {
    const p = activeProfiles()[i];
    if (!p) return;
    lockViewProfileId = p.id;
    renderLockPin();
}

function renderLockCreate() {
    lockView = 'create';
    lockIdTouched = false;
    const lbl = 'block text-xs font-semibold text-gray-700 mb-1';
    const inp = 'w-full border border-gray-300 rounded-xl p-2.5 text-sm focus:outline-none focus:ring-2 focus:ring-brand-500';
    document.getElementById('lockCard').innerHTML = `${lockHeaderHTML()}
        <h2 class="text-center font-bold text-gray-900">Create new profile</h2>
        <p class="text-center text-xs text-gray-500 mt-1">Starts with the default duties. You can add students after logging in.</p>
        <div class="space-y-3 mt-4">
            <div><label class="${lbl}">Your name</label><input id="npName" type="text" maxlength="40" placeholder="e.g. Riya Sharma" oninput="lockNameTyped(this)" class="${inp}"></div>
            <div><label class="${lbl}">Profile ID <span class="font-normal text-gray-400">(used to log in)</span></label><input id="npId" type="text" maxlength="30" placeholder="e.g. riyasharma" autocapitalize="none" autocomplete="off" oninput="lockIdTouched=true" class="${inp}"></div>
            <div class="grid grid-cols-2 gap-3">
                <div><label class="${lbl}">Class</label><input id="npClass" type="text" maxlength="12" placeholder="e.g. 6" class="${inp}"></div>
                <div><label class="${lbl}">Section</label><input id="npSection" type="text" maxlength="6" placeholder="e.g. R" class="${inp}"></div>
            </div>
            <div class="grid grid-cols-2 gap-3">
                <div><label class="${lbl}">PIN (4-8 digits)</label><input id="npPin" type="password" inputmode="numeric" maxlength="8" autocomplete="new-password" oninput="this.value=this.value.replace(/\\D/g,'')" class="${inp}"></div>
                <div><label class="${lbl}">Confirm PIN</label><input id="npPin2" type="password" inputmode="numeric" maxlength="8" autocomplete="new-password" oninput="this.value=this.value.replace(/\\D/g,'')" class="${inp}"></div>
            </div>
            <div><label class="${lbl}">Master PIN <span class="font-normal text-gray-400">(ask the admin)</span></label><input id="npMaster" type="password" inputmode="numeric" maxlength="8" autocomplete="off" oninput="this.value=this.value.replace(/\\D/g,'')" onkeydown="if(event.key==='Enter')submitCreateProfile()" class="${inp}"></div>
        </div>
        <p id="lockError" class="text-xs text-red-500 font-semibold text-center mt-3 min-h-[16px]"></p>
        <button id="npBtn" onclick="submitCreateProfile()" class="w-full mt-2 bg-brand-500 hover:bg-brand-600 text-white py-3 rounded-xl font-semibold text-sm transition shadow">Create & log in</button>
        <button onclick="renderLockChooser()" class="w-full mt-3 text-xs text-gray-500 hover:text-gray-800 font-semibold"><i class="fa-solid fa-arrow-left mr-1"></i>Back to profiles</button>`;
    setLockStatus();
    setTimeout(() => { const i = document.getElementById('npName'); if (i) i.focus(); }, 50);
}
function slugify(s) { return String(s).toLowerCase().replace(/[^a-z0-9]+/g, '').slice(0, 30); }
function lockNameTyped(el) {
    if (lockIdTouched) return;
    const idEl = document.getElementById('npId');
    if (idEl) idEl.value = slugify(el.value);
}

async function finishLogin(r) {
    sessionToken = r.token;
    try { sessionStorage.setItem('pdp_token', r.token); } catch (e) {}
    currentProfile = r.profile;
    try { await refreshProfiles(); } catch (e) {}
    completeLogin(r.profile);
}

async function submitCreateProfile() {
    const v = id => ((document.getElementById(id) || {}).value || '');
    const name = v('npName').replace(/\s+/g, ' ').trim();
    const id = v('npId').trim().toLowerCase();
    const cls = v('npClass').trim(), section = v('npSection').trim();
    const pin = v('npPin').trim(), pin2 = v('npPin2').trim(), masterPin = v('npMaster').trim();
    if (!name) return showLockError('Please enter your name.');
    if (!/^[a-z0-9_-]{3,30}$/.test(id)) return showLockError('Profile ID: 3-30 letters, numbers, - or _ (no spaces).');
    if (!cls) return showLockError('Please enter the class (e.g. 6).');
    if (!section) return showLockError('Please enter the section (e.g. R).');
    if (!validPin(pin)) return showLockError('PIN must be 4 to 8 digits.');
    if (pin !== pin2) return showLockError('The two PINs do not match.');
    if (!masterPin) return showLockError('Enter the master PIN (ask the admin).');
    if (profilesList.find(p => p.id === id)) return showLockError('That profile ID is already taken.');

    const btn = document.getElementById('npBtn');
    if (btn) { btn.disabled = true; btn.textContent = 'Creating...'; }
    showLockError('');
    try {
        const r = await api('/profile/create', { body: { id, name, cls, section, pin, masterPin, starterData: freshProfileData() } });
        await finishLogin(r);
    } catch (err) {
        showLockError(netMsg(err));
        if (btn) { btn.disabled = false; btn.textContent = 'Create & log in'; }
    }
}

async function submitPin() {
    const input = document.getElementById('lockPin');
    const p = profilesList.find(x => x.id === lockViewProfileId);
    if (!input || !p) return;
    const pin = input.value.trim();
    if (!pin) return showLockError('Enter your PIN.');
    const btn = document.getElementById('lockUnlockBtn');
    if (btn) btn.disabled = true;
    try {
        const r = await api('/login', { body: { id: p.id, pin } });      // the server checks the PIN
        showLockError('');
        await finishLogin(r);
    } catch (err) {
        input.value = '';
        if (err.code === 'active_elsewhere') {                      // already logged in somewhere else: ask first
            showLockError('');
            if (btn) btn.disabled = false;
            sgAskTakeover(p, pin, err.other);
            return;
        }
        showLockError(netMsg(err));
        if (btn) btn.disabled = false;
        input.focus();
    }
}

function completeLogin(p) {
    currentProfile = p;
    DATA_FILE = p.dataFile || ('profiles/' + p.id + '.json');
    try { localStorage.setItem('pdp_last_profile', p.id); } catch (e) {}
    document.getElementById('lockScreen').classList.add('hidden');
    sgHideNotice();
    applyProfileToUI();
    sgStart();                                   // begin activity tracking for this login
    if (lockResolve) { const r = lockResolve; lockResolve = null; r(p); }
}

// Resolves once a profile is unlocked. A refresh inside the same tab stays
// unlocked (the server re-checks the session); a fresh visit asks for the PIN.
function requireLogin() {
    return new Promise(async resolve => {
        lockResolve = resolve;
        if (sessionToken) {
            try { const r = await api('/me'); await finishLogin({ token: sessionToken, profile: r.profile }); return; }
            catch (e) { if (!e.network) { clearSession(); if (e.code === 'kicked' || e.code === 'device_changed') sgSetNotice(e.message); } }
        }
        let openSwitcher = false, last = null;
        try {
            openSwitcher = sessionStorage.getItem('pdp_open_switcher') === '1';
            sessionStorage.removeItem('pdp_open_switcher');
            last = localStorage.getItem('pdp_last_profile');
        } catch (e) {}
        const start = activeProfiles().find(p => p.id === last) || activeProfiles().find(p => p.id === DEFAULT_PROFILE_ID) || activeProfiles()[0];
        lockViewProfileId = start.id;
        document.getElementById('lockScreen').classList.remove('hidden');
        sgShowNotice();
        if (openSwitcher) renderLockChooser(); else renderLockPin();
    });
}

// Lock / switch / auto-logout: push any waiting save first, tell the server (so it is recorded), then reload for a completely clean state.
async function lockApp(openSwitcher, reason) {
    if (sgOut) return;
    sgOut = true; sgStop();
    try {
        if (savePending) {
            clearTimeout(saveTimer);
            setSyncUI("Saving before lock...");
            await pushToGitHub();
        }
    } catch (e) { /* data is already saved locally */ }
    await sgSendLogout(reason || 'manual');
    try {
        clearSession();
        if (reason === 'idle') sgSetNotice('You were logged out because there was no activity for 1 minute.');
        if (openSwitcher) sessionStorage.setItem('pdp_open_switcher', '1');
    } catch (e) {}
    location.reload();
}
function switchProfile() { lockApp(true); }

/* ================= SESSION GUARD =================
   - every interaction (click, tap, scroll, key, mouse move, saving/syncing) is noted
   - while the person is interacting, a "still active" signal goes to the server every 5 seconds
   - no interaction for 1 minute -> a 5-second warning, then automatic logout
   - logging in while the profile was active on another device in the last 10 seconds asks first
   - every login / logout (manual or automatic) is recorded by the server with device, browser and IP */
const SG_BEAT_MS = 5000, SG_IDLE_MS = 60000, SG_WARN_MS = 5000;
let sgLast = Date.now(), sgLastSent = 0, sgBeatTimer = null, sgIdleTimer = null, sgWarnAt = 0, sgBusy = false, sgOut = false, sgBound = false, sgMoveAt = 0;
let sgPending = null;                              // { profile, pin } - kept in memory only while the "already in use" question is open

function sgDeviceId() {                            // random id remembered in this browser, so the server can tell devices apart
    try {
        let d = localStorage.getItem('pdp_device_id');
        if (!d) { d = (window.crypto && crypto.randomUUID) ? crypto.randomUUID() : (Date.now().toString(36) + Math.random().toString(36).slice(2)); localStorage.setItem('pdp_device_id', d); }
        return d;
    } catch (e) { return ''; }
}
function sgMarkActivity() { if (!sgWarnAt) sgLast = Date.now(); }   // while the warning is on screen only "Stay logged in" counts

function sgStart() {
    sgOut = false; sgLast = Date.now(); sgLastSent = 0; sgWarnAt = 0; sgBusy = false;
    if (!sgBound) {
        sgBound = true;
        const o = { passive: true, capture: true };
        ['pointerdown', 'keydown', 'wheel', 'touchstart', 'touchmove', 'input', 'scroll'].forEach(ev => window.addEventListener(ev, sgMarkActivity, o));
        window.addEventListener('mousemove', () => { const n = Date.now(); if (n - sgMoveAt > 1000) { sgMoveAt = n; sgMarkActivity(); } }, { passive: true });
        document.addEventListener('visibilitychange', () => { if (document.visibilityState === 'visible' && sessionToken) { sgCheckIdle(); } });
    }
    sgStop(true);
    sgBeatTimer = setInterval(sgBeat, SG_BEAT_MS);
    sgIdleTimer = setInterval(sgCheckIdle, 1000);
    sgBeat();                                      // the login itself is activity - report it straight away
}
function sgStop(keepFlags) {
    clearInterval(sgBeatTimer); clearInterval(sgIdleTimer); sgBeatTimer = sgIdleTimer = null;
    if (!keepFlags) { sgWarnAt = 0; const w = document.getElementById('idleWarnModal'); if (w) w.classList.add('hidden'); }
}

async function sgBeat() {
    if (sgOut || sgBusy || !sessionToken) return;
    if (sgLast === sgLastSent) return;             // nothing new since the last report
    const sent = sgLast;
    sgBusy = true;
    try {
        await api('/session/ping', { body: { idle: Math.max(0, Date.now() - sent) } });
        sgLastSent = sent;
    } catch (e) {
        if (e.status === 401) sgRemoteLogout(e);   // another device took over (or the session ended): leave this one
        /* network trouble: simply try again at the next beat */
    } finally { sgBusy = false; }
}

function sgRemoteLogout(e) {
    if (sgOut) return;
    sgOut = true; sgStop();
    sgSetNotice(e.code === 'kicked' ? 'You were logged out because this profile was logged in on another device.' : (e.message || 'Your session ended - please log in again.'));
    clearSession();
    location.reload();
}

function sgCheckIdle() {
    if (sgOut || !sessionToken) return;
    const now = Date.now(), idle = now - sgLast;
    if (!sgWarnAt) {
        if (idle < SG_IDLE_MS) return;
        if (idle >= SG_IDLE_MS + SG_WARN_MS) { lockApp(false, 'idle'); return; }   // device was asleep / tab in background: the warning time has already passed
        sgWarnAt = now;
        const w = document.getElementById('idleWarnModal');
        if (w) { w.classList.remove('hidden'); const b = document.getElementById('idleStayBtn'); if (b) b.focus(); }
    }
    const left = Math.ceil((sgWarnAt + SG_WARN_MS - now) / 1000);
    const c = document.getElementById('idleWarnCount');
    if (c) c.textContent = Math.max(left, 0);
    if (left <= 0) lockApp(false, 'idle');
}
function sgStay() {
    sgWarnAt = 0;
    const w = document.getElementById('idleWarnModal'); if (w) w.classList.add('hidden');
    sgLast = Date.now();
    sgBeat();
}

async function sgSendLogout(reason) {              // records the logout on the server (never waits more than 2.5 s)
    if (!sessionToken) return;
    try { await Promise.race([api('/logout', { body: { reason } }), new Promise(r => setTimeout(r, 2500))]); } catch (e) {}
}

/* ---- notices on the login screen ---- */
function sgSetNotice(msg) { try { sessionStorage.setItem('pdp_notice', msg); } catch (e) {} }
function sgShowNotice() {
    let m = '';
    try { m = sessionStorage.getItem('pdp_notice') || ''; sessionStorage.removeItem('pdp_notice'); } catch (e) {}
    const el = document.getElementById('lockNotice');
    if (el && m) { el.textContent = m; el.classList.remove('hidden'); }
}
function sgHideNotice() { const el = document.getElementById('lockNotice'); if (el) { el.textContent = ''; el.classList.add('hidden'); } }

/* ---- "this profile is already in use on another device" ---- */
function sgAgo(sec) { return sec < 2 ? 'just now' : sec + ' seconds ago'; }
function sgAskTakeover(p, pin, o) {
    o = o || {};
    sgPending = { profile: p, pin };
    const row = (k, v) => v ? `<div class="flex justify-between gap-3"><span class="text-gray-500">${k}</span><span class="font-semibold text-gray-900 text-right break-all">${esc(v)}</span></div>` : '';
    const when = o.at ? new Date(o.at).toLocaleString('en-GB', { day: 'numeric', month: 'short', hour: '2-digit', minute: '2-digit' }) : '';
    document.getElementById('scBody').innerHTML = `
        <p><b>${esc(p.name)}</b> is logged in ${o.sameDevice ? 'in another tab or window on <b>this device</b>' : 'on <b>another device</b>'} and was active <b>${esc(sgAgo(Number(o.agoSec) || 0))}</b>.</p>
        <div class="bg-gray-50 border border-gray-200 rounded-xl p-3 text-xs space-y-1.5">
            ${row('Browser / device', o.device)}${row('IP address', o.ip)}${row('Location', o.loc)}${row('Logged in at', when)}
        </div>
        <p class="text-xs text-gray-600">If you continue, that session is <b>logged out immediately</b> and this device takes over. Any change made there in the last few seconds may not be saved.</p>`;
    const y = document.getElementById('scYesBtn'); y.disabled = false; y.textContent = 'Yes, log in here';
    document.getElementById('scNoBtn').disabled = false;
    document.getElementById('sessionConflictModal').classList.remove('hidden');
    setTimeout(() => document.getElementById('scNoBtn').focus(), 50);
}
function sgCloseTakeover() { sgPending = null; document.getElementById('sessionConflictModal').classList.add('hidden'); }
function sgTakeoverNo() {
    sgCloseTakeover();
    const i = document.getElementById('lockPin'), b = document.getElementById('lockUnlockBtn');
    if (b) b.disabled = false;
    if (i) i.focus();
}
async function sgTakeoverYes() {
    const q = sgPending;
    if (!q) return;
    const y = document.getElementById('scYesBtn'), n = document.getElementById('scNoBtn');
    y.disabled = true; n.disabled = true; y.textContent = 'Logging in...';
    try {
        const r = await api('/login', { body: { id: q.profile.id, pin: q.pin, force: true } });
        sgCloseTakeover();
        showLockError('');
        await finishLogin(r);
    } catch (err) {
        sgCloseTakeover();
        showLockError(netMsg(err));
    }
}

/* ---- sign-in activity in Profile settings ---- */
function sgWhen(t) { return t ? new Date(t).toLocaleString('en-GB', { day: 'numeric', month: 'short', hour: '2-digit', minute: '2-digit' }) : '-'; }
const SG_EVENT_LABEL = { login: ['Logged in', 'fa-right-to-bracket text-green-600'], login_takeover: ['Logged in (took over another device)', 'fa-right-left text-amber-600'], logout: ['Logged out', 'fa-right-from-bracket text-gray-500'], auto_logout: ['Logged out automatically (inactive)', 'fa-clock text-amber-600'] };
async function sgLoadActivity() {
    const box = document.getElementById('psActivity');
    if (!box) return;
    try {
        const r = await api('/session/log');
        if (!document.getElementById('psActivity')) return;
        const ev = (r.events || []).slice(0, 10).map(e => {
            const l = SG_EVENT_LABEL[e.type] || [e.type, 'fa-circle text-gray-400'];
            return `<div class="p-2.5 bg-gray-50 border border-gray-200 rounded-xl"><p class="text-xs font-bold text-gray-900"><i class="fa-solid ${l[1]} mr-1.5"></i>${esc(l[0])}</p><p class="text-[11px] text-gray-500">${esc(sgWhen(e.at))} &bull; ${esc(e.device || '')}${e.ip ? ' &bull; ' + esc(e.ip) : ''}${e.loc ? ' &bull; ' + esc(e.loc) : ''}</p>${e.note ? `<p class="text-[11px] text-gray-400">${esc(e.note)}</p>` : ''}</div>`;
        }).join('');
        const stateTxt = { active: ['Active now', 'text-green-600'], idle: ['Not active right now', 'text-amber-600'], out: ['Logged out', 'text-gray-400'] };
        const live = r.profiles ? `<p class="text-xs font-bold text-gray-900 mt-4 mb-2">All profiles - who is logged in</p>` + r.profiles.map(x => {
            const st = stateTxt[x.state] || stateTxt.out;
            return `<div class="p-2.5 bg-white border border-gray-200 rounded-xl mb-1.5"><p class="text-xs font-bold text-gray-900 truncate">${esc(x.name)} <span class="font-semibold ${st[1]}">&bull; ${st[0]}</span></p><p class="text-[11px] text-gray-500">${x.state === 'out' ? (x.loggedOutAt ? 'Logged out ' + esc(sgWhen(x.loggedOutAt)) : 'Not logged in') : esc((x.device || '') + (x.ip ? ' \u2022 ' + x.ip : '') + (x.loc ? ' \u2022 ' + x.loc : '')) + '<br>Last activity ' + esc(sgWhen(x.lastActive))}</p></div>`;
        }).join('') : '';
        box.innerHTML = (r.kv === false ? '<p class="text-xs text-gray-400">Activity tracking is not available on the server yet (the SESSIONS Durable Object is missing).</p>' : '')
            + `<div class="space-y-1.5">${ev || '<p class="text-xs text-gray-400">No sign-ins recorded yet.</p>'}</div>` + live;
    } catch (e) { if (document.getElementById('psActivity')) box.innerHTML = '<p class="text-xs text-gray-400">Could not load sign-in activity.</p>'; }
}

/* ---------- Showing the active profile in the header / sidebar ---------- */
function applyProfileToUI() {
    const p = currentProfile;
    if (!p) return;
    const set = (id, txt) => { const el = document.getElementById(id); if (el) el.textContent = txt; };
    set('hdrAvatar', initialsOf(p.name));
    set('hdrProfileName', p.name);
    set('hdrProfileSub', classLabel(p) || 'PDP Incharge');
    set('sbProfileAvatar', initialsOf(p.name));
    set('sbProfileName', p.name);
    set('sbProfileSub', (classLabel(p) ? classLabel(p) + ' \u2022 ' : '') + '@' + p.id);
}

/* ---------- Profile settings (details, PIN, admin tools) ---------- */
function psMsg(text, ok) {
    const el = document.getElementById('psMsg');
    if (!el) return;
    el.textContent = text || '';
    el.className = 'text-xs font-semibold min-h-[16px] ' + (ok ? 'text-green-600' : 'text-red-500');
}
function openProfileSettings() {
    if (!currentProfile) return;
    if (sidebarOpen && window.innerWidth < 1024) { sidebarOpen = false; applySidebarState(); }
    renderProfileSettings();
    document.getElementById('profileSettingsModal').classList.remove('hidden');
}
function closeProfileSettings() { document.getElementById('profileSettingsModal').classList.add('hidden'); }

function renderProfileSettings() {
    const p = profilesList.find(x => x.id === currentProfile.id) || currentProfile;
    const lbl = 'block text-xs font-semibold text-gray-700 mb-1';
    const inp = 'w-full border border-gray-300 rounded-xl p-2.5 text-sm focus:outline-none focus:ring-2 focus:ring-brand-500';
    const btn = 'bg-brand-500 hover:bg-brand-600 text-white px-4 py-2.5 rounded-xl text-sm font-semibold transition shadow';
    let admin = '';
    if (p.admin) {
        const others = profilesList.map((x, i) => ({ x, i })).filter(o => o.x.id !== p.id && !o.x.archived);
        const archivedRows = profilesList.map((x, i) => ({ x, i })).filter(o => o.x.archived);
        const archivedHTML = archivedRows.length ? `<div class="mt-4 pt-4 border-t border-dashed border-gray-300">
            <h4 class="text-sm font-bold text-gray-900 mb-1"><i class="fa-solid fa-box-archive text-brand-500 mr-2"></i>Archived profiles</h4>
            <p class="text-xs text-gray-500 mb-3">Hidden from login, but all their data is kept. Restore them, download a backup, or delete them for good.</p>
            ${archivedRows.map(o => `
            <div class="p-3 bg-white border border-dashed border-gray-300 rounded-xl mb-2">
                <p class="text-sm font-bold text-gray-900 truncate">${esc(o.x.name)}</p>
                <p class="text-[11px] text-gray-500 truncate mb-2">${esc(classLabel(o.x) || '-')} &bull; @${esc(o.x.id)}${o.x.archivedAt ? ' &bull; archived ' + esc(new Date(o.x.archivedAt).toLocaleDateString('en-GB', { day: 'numeric', month: 'short', year: 'numeric' })) : ''}</p>
                <div class="flex flex-wrap gap-2">
                    <button onclick="restoreArchivedProfile(${o.i})" class="text-xs font-semibold px-3 py-1.5 rounded-lg border border-brand-500 text-brand-600 hover:bg-brand-50 transition"><i class="fa-solid fa-rotate-left mr-1"></i>Restore</button>
                    <button onclick="downloadArchivedBackup(${o.i})" class="text-xs font-semibold px-3 py-1.5 rounded-lg border border-gray-300 text-gray-700 hover:bg-gray-50 transition"><i class="fa-solid fa-download mr-1"></i>Backup</button>
                    <button onclick="openDeleteProfile(${o.i})" class="text-xs font-semibold px-3 py-1.5 rounded-lg border border-red-200 text-red-600 hover:bg-red-50 transition"><i class="fa-solid fa-trash mr-1"></i>Delete forever</button>
                </div>
            </div>`).join('')}
        </div>` : '';
        const masterBox = `<div class="mb-4 p-3 bg-gray-50 border border-gray-200 rounded-xl">
            <h5 class="text-xs font-bold text-gray-900 mb-1"><i class="fa-solid fa-lock text-brand-500 mr-1.5"></i>Master PIN</h5>
            <p class="text-[11px] text-gray-500 mb-2">Needed to create a new profile. Share it only with teachers you trust.</p>
            <div class="grid grid-cols-2 gap-3 mb-2">
                <div><label class="${lbl}">Current master PIN</label><input id="psMasterOld" type="password" inputmode="numeric" maxlength="8" autocomplete="off" oninput="this.value=this.value.replace(/\\D/g,'')" class="${inp}"></div>
                <div><label class="${lbl}">New master PIN</label><input id="psMasterNew" type="password" inputmode="numeric" maxlength="8" autocomplete="off" oninput="this.value=this.value.replace(/\\D/g,'')" class="${inp}"></div>
            </div>
            <button onclick="changeMasterPin()" class="${btn}">Update master PIN</button>
        </div>`;
        admin = `<div class="border-t border-gray-200 pt-4">
            <h4 class="text-sm font-bold text-gray-900 mb-1"><i class="fa-solid fa-user-shield text-brand-500 mr-2"></i>All profiles <span class="text-[10px] font-semibold text-gray-400 uppercase ml-1">Admin</span></h4>
            <p class="text-xs text-gray-500 mb-3">Reset a forgotten PIN, or delete / archive a profile. The default profile (${esc(p.name)}) can never be deleted.</p>
            ${masterBox}
            ${others.length ? others.map(o => `
            <div class="flex items-center justify-between gap-2 p-3 bg-gray-50 border border-gray-200 rounded-xl mb-2">
                <div class="min-w-0"><p class="text-sm font-bold text-gray-900 truncate">${esc(o.x.name)}</p><p class="text-[11px] text-gray-500 truncate">${esc(classLabel(o.x) || '-')} &bull; @${esc(o.x.id)}</p></div>
                <div class="flex space-x-2 shrink-0">
                    <button onclick="adminResetPin(${o.i})" class="text-xs font-semibold px-3 py-1.5 rounded-lg border border-gray-300 hover:bg-white text-gray-700 transition">Reset PIN</button>
                    <button onclick="openDeleteProfile(${o.i})" class="text-xs font-semibold px-3 py-1.5 rounded-lg border border-red-200 text-red-600 hover:bg-red-50 transition">Delete</button>
                </div>
            </div>`).join('') : '<p class="text-xs text-gray-400">No other profiles yet.</p>'}
            ${archivedHTML}
        </div>`;
    }
    let danger = '';
    if (!isDefaultProfile(p)) {
        const ownIdx = profilesList.findIndex(x => x.id === p.id);
        danger = `<div class="border-t border-gray-200 pt-4">
            <h4 class="text-sm font-bold text-red-600 mb-1"><i class="fa-solid fa-triangle-exclamation mr-2"></i>Delete my profile</h4>
            <p class="text-xs text-gray-500 mb-3">You choose what happens to your data: archive it (the admin can restore it), download a backup copy, or erase everything permanently.</p>
            <button onclick="openDeleteProfile(${ownIdx})" class="text-sm font-semibold px-4 py-2.5 rounded-xl border border-red-200 text-red-600 hover:bg-red-50 transition"><i class="fa-solid fa-trash mr-2"></i>Delete this profile...</button>
        </div>`;
    }
    document.getElementById('profileSettingsBody').innerHTML = `
        <div>
            <h4 class="text-sm font-bold text-gray-900 mb-3"><i class="fa-solid fa-id-card text-brand-500 mr-2"></i>My details</h4>
            <div class="space-y-3">
                <div><label class="${lbl}">Name</label><input id="psName" type="text" maxlength="40" value="${esc(p.name)}" class="${inp}"></div>
                <div class="grid grid-cols-2 gap-3">
                    <div><label class="${lbl}">Class</label><input id="psClass" type="text" maxlength="12" value="${esc(p.cls || '')}" class="${inp}"></div>
                    <div><label class="${lbl}">Section</label><input id="psSection" type="text" maxlength="6" value="${esc(p.section || '')}" class="${inp}"></div>
                </div>
                <p class="text-[11px] text-gray-400">Profile ID: @${esc(p.id)} (cannot be changed). Class and section are used as the default when adding students.</p>
                <button onclick="saveProfileDetails()" class="${btn}">Save details</button>
            </div>
        </div>
        <div class="border-t border-gray-200 pt-4">
            <h4 class="text-sm font-bold text-gray-900 mb-3"><i class="fa-solid fa-key text-brand-500 mr-2"></i>Change PIN</h4>
            <div class="space-y-3">
                <div><label class="${lbl}">Current PIN</label><input id="psOldPin" type="password" inputmode="numeric" maxlength="8" autocomplete="current-password" oninput="this.value=this.value.replace(/\\D/g,'')" class="${inp}"></div>
                <div class="grid grid-cols-2 gap-3">
                    <div><label class="${lbl}">New PIN (4-8 digits)</label><input id="psNewPin" type="password" inputmode="numeric" maxlength="8" autocomplete="new-password" oninput="this.value=this.value.replace(/\\D/g,'')" class="${inp}"></div>
                    <div><label class="${lbl}">Confirm new PIN</label><input id="psNewPin2" type="password" inputmode="numeric" maxlength="8" autocomplete="new-password" oninput="this.value=this.value.replace(/\\D/g,'')" class="${inp}"></div>
                </div>
                <button onclick="changeMyPin()" class="${btn}">Update PIN</button>
            </div>
        </div>
        <div class="border-t border-gray-200 pt-4">
            <h4 class="text-sm font-bold text-gray-900 mb-1"><i class="fa-solid fa-shield-halved text-brand-500 mr-2"></i>Sign-in activity</h4>
            <p class="text-xs text-gray-500 mb-3">Where and when this profile was logged in or out. You are logged out automatically after 1 minute without activity.</p>
            <div id="psActivity"><p class="text-xs text-gray-400">Loading...</p></div>
        </div>
        ${admin}
        ${danger}
        <p id="psMsg" class="text-xs font-semibold min-h-[16px]"></p>`;
    sgLoadActivity();
}

async function saveProfileDetails() {
    const v = id => ((document.getElementById(id) || {}).value || '').trim();
    const name = v('psName').replace(/\s+/g, ' '), cls = v('psClass'), section = v('psSection');
    if (!name) return psMsg('Name cannot be empty.');
    if (!cls || !section) return psMsg('Please fill in both class and section.');
    psMsg('Saving...', true);
    try {
        await api('/profile/update', { body: { name, cls, section } });
        currentProfile = Object.assign({}, currentProfile, { name, cls, section });
        await refreshProfiles();
        applyProfileToUI();
        psMsg('Details saved.', true);
    } catch (err) { psMsg(netMsg(err)); }
}

async function changeMyPin() {
    const v = id => ((document.getElementById(id) || {}).value || '').trim();
    const oldPin = v('psOldPin'), n1 = v('psNewPin'), n2 = v('psNewPin2');
    if (!oldPin) return psMsg('Enter your current PIN.');
    if (!validPin(n1)) return psMsg('New PIN must be 4 to 8 digits.');
    if (n1 !== n2) return psMsg('The new PINs do not match.');
    psMsg('Saving...', true);
    try {
        await api('/pin/change', { body: { oldPin, newPin: n1 } });
        ['psOldPin', 'psNewPin', 'psNewPin2'].forEach(id => { const el = document.getElementById(id); if (el) el.value = ''; });
        psMsg('PIN updated.', true);
    } catch (err) { psMsg(netMsg(err)); }
}

async function changeMasterPin() {
    const v = id => ((document.getElementById(id) || {}).value || '').trim();
    const oldPin = v('psMasterOld'), n1 = v('psMasterNew');
    if (!oldPin) return psMsg('Enter the current master PIN (default 1997).');
    if (!validPin(n1)) return psMsg('New master PIN must be 4 to 8 digits.');
    psMsg('Saving...', true);
    try {
        await api('/master-pin', { body: { oldPin, newPin: n1 } });
        ['psMasterOld', 'psMasterNew'].forEach(id => { const el = document.getElementById(id); if (el) el.value = ''; });
        psMsg('Master PIN updated.', true);
    } catch (err) { psMsg(netMsg(err)); }
}

async function adminResetPin(i) {
    const t = profilesList[i];
    if (!t || !currentProfile.admin || t.id === currentProfile.id) return;
    const pin = (prompt(`New PIN for ${t.name} (4-8 digits):`) || '').trim();
    if (!pin) return;
    if (!validPin(pin)) return psMsg('PIN must be 4 to 8 digits.');
    psMsg('Saving...', true);
    try {
        await api('/admin/reset-pin', { body: { id: t.id, pin } });
        renderProfileSettings();
        psMsg(`PIN reset for ${t.name}.`, true);
    } catch (err) { psMsg(netMsg(err)); }
}

/* ---------- Delete or archive a profile ----------
   Everyone can delete their OWN profile (PIN needed); the admin can delete any profile.
   The default profile can never be deleted.
   What happens to the data is the user's choice:
     - Archive (recommended): profile is hidden and cannot log in, all data kept; the admin can restore it.
     - Delete permanently: profile and ALL its data are erased.
     - Either way a backup copy (.json) can be downloaded first. */
let delTarget = null;
let delMode = 'archive';

function canDeleteProfile(t) {
    return !!t && !!currentProfile && t.id !== DEFAULT_PROFILE_ID && (!!currentProfile.admin || currentProfile.id === t.id);
}
function profileDataPath(p) { return p.dataFile || ('profiles/' + p.id + '.json'); }

async function fetchProfileData(p) {
    if (currentProfile && p.id === currentProfile.id) return JSON.parse(JSON.stringify(appData));   // the freshest copy is the one open on screen
    const res = await fetch(ghUrl(profileDataPath(p)), { headers: githubHeaders(), cache: 'no-store' });
    if (res.status === 404) return null;
    if (!res.ok) throw new Error('Could not read the profile data (status ' + res.status + ')');
    const meta = await res.json();
    if (!meta.content) throw new Error('This profile has too much data to download from here.');
    return JSON.parse(b64decode(meta.content));
}
function summarizeProfileData(d) {
    if (!d) return 'No data saved yet.';
    let records = 0; const months = [];
    Object.keys(d.assignments || {}).sort().forEach(mk => {
        let n = 0;
        Object.values(d.assignments[mk] || {}).forEach(days => Object.values(days || {}).forEach(l => { n += (l || []).length; }));
        if (n) { records += n; months.push(mk); }
    });
    const fmt = mk => { const [y, m] = mk.split('-').map(Number); return new Date(y, m - 1, 1).toLocaleDateString('en-GB', { month: 'short', year: 'numeric' }); };
    const span = months.length ? ' \u2022 ' + (months.length === 1 ? fmt(months[0]) : fmt(months[0]) + ' \u2013 ' + fmt(months[months.length - 1])) : '';
    return `${(d.students || []).length} student(s) \u2022 ${(d.duties || []).length} duties \u2022 ${records} duty record(s)${span}`;
}
function downloadJson(filename, obj) {
    const blob = new Blob([JSON.stringify(obj, null, 2)], { type: 'application/json' });
    const a = document.createElement('a');
    a.href = URL.createObjectURL(blob);
    a.download = filename;
    document.body.appendChild(a);
    a.click();
    a.remove();
    setTimeout(() => { try { URL.revokeObjectURL(a.href); } catch (e) {} }, 3000);
}
// Downloads everything in a profile (never the PIN). Returns false if there is nothing saved yet.
async function downloadProfileBackup(p) {
    const data = await fetchProfileData(p);
    if (!data) return false;
    downloadJson(`pdp-backup-${p.id}-${new Date().toISOString().slice(0, 10)}.json`, {
        pdpProfileBackup: 1, exportedAt: new Date().toISOString(),
        profile: { id: p.id, name: p.name, cls: p.cls, section: p.section }, data
    });
    return true;
}

function openDeleteProfile(i) {
    const t = profilesList[i];
    if (!canDeleteProfile(t)) return;
    delTarget = t;
    delMode = t.archived ? 'delete' : 'archive';
    renderDeleteProfileModal();
    document.getElementById('deleteProfileModal').classList.remove('hidden');
    fetchProfileData(t)
        .then(d => { const el = document.getElementById('delSummary'); if (el && delTarget === t) el.textContent = summarizeProfileData(d); })
        .catch(() => { const el = document.getElementById('delSummary'); if (el && delTarget === t) el.textContent = 'Could not read what this profile holds.'; });
}
function closeDeleteProfile() {
    document.getElementById('deleteProfileModal').classList.add('hidden');
    delTarget = null;
}
function delMsg(text, ok) {
    const el = document.getElementById('delMsg');
    if (!el) return;
    el.textContent = text || '';
    el.className = 'empty:hidden text-xs font-semibold ' + (ok ? 'text-green-600' : 'text-red-500');
}
function renderDeleteProfileModal() {
    const t = delTarget;
    const own = currentProfile.id === t.id;
    const inp = 'w-full border border-gray-300 rounded-xl p-2.5 text-sm focus:outline-none focus:ring-2 focus:ring-brand-500';
    const radios = t.archived ? `<p class="text-xs text-gray-500">This profile is already archived. Deleting it now removes it and all its data for good.</p>` : `
        <div class="space-y-2">
            <label id="delOptArchive" class="flex items-start gap-3 p-3 rounded-xl border cursor-pointer transition">
                <input type="radio" name="delMode" value="archive" onchange="setDelMode('archive')" class="mt-1">
                <span class="text-sm"><b class="text-gray-900">Archive</b> <span class="text-[10px] font-bold bg-brand-100 text-brand-900 px-1.5 py-0.5 rounded-full ml-1">Recommended</span><br>
                <span class="text-xs text-gray-500">Hides the profile and blocks login, but keeps every student, duty and record. The admin can restore it any time.</span></span>
            </label>
            <label id="delOptDelete" class="flex items-start gap-3 p-3 rounded-xl border cursor-pointer transition">
                <input type="radio" name="delMode" value="delete" onchange="setDelMode('delete')" class="mt-1">
                <span class="text-sm"><b class="text-red-600">Delete permanently</b><br>
                <span class="text-xs text-gray-500">Erases the profile with all its students, duties and history. This cannot be undone.</span></span>
            </label>
        </div>`;
    document.getElementById('deleteProfileBody').innerHTML = `
        <div class="flex items-center space-x-3 p-3 bg-gray-50 rounded-xl border border-gray-200">
            <div class="w-10 h-10 rounded-full bg-brand-100 text-brand-900 flex items-center justify-center font-bold text-sm border border-brand-500/30 shrink-0">${esc(initialsOf(t.name))}</div>
            <div class="min-w-0"><p class="text-sm font-bold text-gray-900 truncate">${esc(t.name)}${own ? ' <span class="text-[10px] font-semibold text-gray-400">(you)</span>' : ''}</p><p class="text-xs text-gray-500 truncate">${esc(classLabel(t) || '-')} &bull; @${esc(t.id)}</p></div>
        </div>
        <p id="delSummary" class="text-xs text-gray-500 -mt-2">Checking what this profile holds...</p>
        <label class="flex items-start gap-2 text-sm text-gray-800 cursor-pointer"><input type="checkbox" id="delBackup" checked class="mt-1"><span>Download a backup copy (.json) first <span class="text-xs text-gray-400">(recommended)</span></span></label>
        ${radios}
        <div id="delTypeWrap" class="hidden"><label class="block text-xs font-semibold text-gray-700 mb-1">Type <b>${esc(t.id)}</b> to confirm permanent deletion</label><input id="delTyped" type="text" autocomplete="off" autocapitalize="none" class="${inp}"></div>
        ${own ? `<div><label class="block text-xs font-semibold text-gray-700 mb-1">Enter your PIN to confirm</label><input id="delPin" type="password" inputmode="numeric" maxlength="8" autocomplete="current-password" oninput="this.value=this.value.replace(/\\D/g,'')" class="${inp}"></div>` : ''}
        `;
    delMsg('');
    const cb = document.getElementById('delConfirmBtn');
    cb.disabled = false;
    cb.classList.remove('opacity-60');
    applyDelMode();
}
function setDelMode(m) { delMode = m; applyDelMode(); }
function applyDelMode() {
    const t = delTarget; if (!t) return;
    const mode = t.archived ? 'delete' : delMode;
    const a = document.getElementById('delOptArchive'), d = document.getElementById('delOptDelete');
    if (a) { a.className = 'flex items-start gap-3 p-3 rounded-xl border cursor-pointer transition ' + (mode === 'archive' ? 'border-brand-500 bg-brand-50' : 'border-gray-200'); a.querySelector('input').checked = mode === 'archive'; }
    if (d) { d.className = 'flex items-start gap-3 p-3 rounded-xl border cursor-pointer transition ' + (mode === 'delete' ? 'border-red-400 bg-red-50' : 'border-gray-200'); d.querySelector('input').checked = mode === 'delete'; }
    document.getElementById('delTypeWrap').classList.toggle('hidden', mode !== 'delete');
    const b = document.getElementById('delConfirmBtn');
    b.textContent = mode === 'archive' ? 'Archive profile' : 'Delete permanently';
    b.className = 'px-4 py-2.5 rounded-xl text-sm font-bold text-white transition shadow ' + (mode === 'archive' ? 'bg-brand-500 hover:bg-brand-600' : 'bg-red-500 hover:bg-red-600');
}

async function confirmDeleteProfile() {
    const t = delTarget;
    if (!canDeleteProfile(t)) return;
    const own = currentProfile.id === t.id;
    const mode = t.archived ? 'delete' : delMode;
    const wantBackup = !!(document.getElementById('delBackup') || {}).checked;
    if (mode === 'delete') {
        const typed = ((document.getElementById('delTyped') || {}).value || '').trim().replace(/^@/, '').toLowerCase();
        if (typed !== t.id) return delMsg('Type the profile ID "' + t.id + '" exactly to confirm.');
    }
    let pin = '';
    if (own) {
        pin = ((document.getElementById('delPin') || {}).value || '').trim();
        if (!pin) return delMsg('Enter your PIN to confirm.');       // the server checks it
    }
    const btn = document.getElementById('delConfirmBtn');
    btn.disabled = true; btn.classList.add('opacity-60');
    delMsg('Working...', true);
    try {
        // archiving your own profile: make sure the very latest changes reach the cloud before it is hidden
        if (own && mode === 'archive' && savePending) { clearTimeout(saveTimer); await pushToGitHub(); }
        if (wantBackup) await downloadProfileBackup(t);          // if this fails we stop, so nothing is lost
        if (mode === 'archive') {
            await api('/profile/archive', { body: { id: t.id, pin } });
        } else {
            if (own) { clearTimeout(saveTimer); savePending = false; }   // never let a waiting save re-create the deleted data
            await api('/profile/delete', { body: { id: t.id, pin } });      // the server also erases the data file
            try { ['pdp_data_', 'pdp_backup_'].forEach(k => localStorage.removeItem(k + t.id)); localStorage.removeItem('pdp_data_' + t.id + '_pre_ids'); } catch (e) {}
        }
        try { if (localStorage.getItem('pdp_last_profile') === t.id) localStorage.removeItem('pdp_last_profile'); } catch (e) {}
        closeDeleteProfile();
        if (own) {                                                   // you just removed the profile you are using: back to the login screen
            clearSession();
            location.reload();
            return;
        }
        await refreshProfiles();
        renderProfileSettings();
        psMsg(mode === 'archive' ? `"${t.name}" archived. Find it under Archived profiles.` : `"${t.name}" deleted permanently.`, true);
    } catch (err) {
        delMsg(netMsg(err));
        btn.disabled = false; btn.classList.remove('opacity-60');
    }
}

async function restoreArchivedProfile(i) {
    const t = profilesList[i];
    if (!t || !t.archived || !currentProfile.admin) return;
    const raw = prompt(`Restore ${t.name}?\n\nSet a new PIN (4-8 digits), or leave blank to keep their old PIN:`);
    if (raw === null) return;
    const pin = raw.trim();
    if (pin && !validPin(pin)) return psMsg('PIN must be 4 to 8 digits.');
    psMsg('Restoring...', true);
    try {
        await api('/admin/restore', { body: { id: t.id, pin } });
        await refreshProfiles();
        renderProfileSettings();
        psMsg(`"${t.name}" restored. They can log in again.`, true);
    } catch (err) { psMsg(netMsg(err)); }
}
async function downloadArchivedBackup(i) {
    const t = profilesList[i];
    if (!t || !currentProfile.admin) return;
    psMsg('Preparing backup...', true);
    try {
        const ok = await downloadProfileBackup(t);
        psMsg(ok ? 'Backup downloaded.' : 'This profile has no saved data to back up.', ok);
    } catch (err) { psMsg(netMsg(err)); }
}

/* ================= KEYBOARD & STARTUP ================= */

document.addEventListener('keydown', (e) => {
    if (e.key === 'Escape') {
        if (!document.getElementById('cellModal').classList.contains('hidden')) cancelCellModal();
        if (!document.getElementById('clearDutiesModal').classList.contains('hidden')) closeClearDutiesModal();
        if (!document.getElementById('cleanViewModal').classList.contains('hidden')) closeCleanViewModal();
        if (!document.getElementById('studentDutyModal').classList.contains('hidden')) closeStudentDutyModal();
        if (!document.getElementById('holidaysModal').classList.contains('hidden')) closeHolidaysModal();
        if (!document.getElementById('swapModal').classList.contains('hidden')) closeSwapModal();
        if (!document.getElementById('todayViewModal').classList.contains('hidden')) closeTodayView();
        if (!document.getElementById('deleteProfileModal').classList.contains('hidden')) { closeDeleteProfile(); return; }
        if (!document.getElementById('profileSettingsModal').classList.contains('hidden')) closeProfileSettings();
        if (!document.getElementById('archiveModal').classList.contains('hidden')) closeArchiveModal();
        if (!document.getElementById('importModal').classList.contains('hidden')) closeImportModal();
    }
});

window.onload = async () => {
    // Sidebar starts open on wide screens (laptop / tablet landscape),
    // closed on small screens. Either way it can be toggled with the
    // hamburger or the cross button.
    sidebarOpen = window.innerWidth >= 1024;
    applySidebarState();

    // PROFILES: fetch the latest profile list in the background, then wait here
    // until a teacher has unlocked a profile with their PIN.
    profilesReady = loadProfiles();
    await requireLogin();
    // A brand-new profile starts with the default duties and no students
    if (currentProfile.id !== DEFAULT_PROFILE_ID) appData = freshProfileData();

    // Show the app immediately using the local copy - no more frozen screen.
    switchTab('planner');
    // Then bring in the cloud data in the background.
    await loadFromGitHub();
    if (normalizeAppData()) needsNameFixSave = true;
    renderPlanner();
    if (needsNameFixSave) { needsNameFixSave = false; saveToStorage(); }
    if (lastMigrationReport) { const r = lastMigrationReport; lastMigrationReport = null; announceMigration(r); }
};
