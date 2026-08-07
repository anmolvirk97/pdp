const JSONBIN_BIN_ID = "6a745cbbf5f4af5e29f23b4e";
const JSONBIN_API_KEY = "$2a$10$d9RGaVsdrKZXIhTTj4RzHePqxZ7Kmu1yozCO88WsjnmEIfrTctnP6";

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

let appData = {
    duties: [...defaultDuties],
    students: [...defaultStudents],
    assignments: {}
};

// Undo stack for clear duties operations
let lastStateBackup = null;

// FIX: Default to current real month/year instead of hardcoded July 2026
const today = new Date();
let currentYear = today.getFullYear();
let currentMonth = today.getMonth();

let currentEditingCell = { year: currentYear, month: currentMonth, day: 1, dutyIdx: 0 };
let currentZoom = 1;

let cleanViewSelectedWeekdays = [1, 2, 3, 4, 5, 6]; // Mon=1 ... Sat=6
let cleanViewControlsVisible = true;

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

// FIX: Temporary state for cell modal so Cancel actually works
let modalTempAssignments = [];

// FIX: Register inline Service Worker & Manifest for real PWA support
(function setupPWA() {
    const manifest = {
        name: "PDP Morning Assembly Duty Planner",
        short_name: "PDP Planner",
        start_url: ".",
        display: "standalone",
        background_color: "#fdf8f0",
        theme_color: "#d99b26",
        icons: []
    };
    const manifestBlob = new Blob([JSON.stringify(manifest)], { type: 'application/json' });
    const manifestURL = URL.createObjectURL(manifestBlob);
    const link = document.createElement('link');
    link.rel = 'manifest';
    link.href = manifestURL;
    document.head.appendChild(link);

    const swCode = `
        const CACHE_NAME = 'pdp-duty-planner-v1';
        self.addEventListener('install', e => {
            e.waitUntil(caches.open(CACHE_NAME).then(cache => cache.addAll(['./'])));
            self.skipWaiting();
        });
        self.addEventListener('activate', e => {
            e.waitUntil(self.clients.claim());
        });
        self.addEventListener('fetch', e => {
            e.respondWith(
                caches.match(e.request).then(response => {
                    return response || fetch(e.request).catch(() => caches.match('./'));
                })
            );
        });
    `;
    if ('serviceWorker' in navigator) {
        const blob = new Blob([swCode], { type: 'application/javascript' });
        const swUrl = URL.createObjectURL(blob);
        navigator.serviceWorker.register(swUrl).catch(err => console.error('SW registration failed:', err));
    }
})();

async function initApp() {
    await loadFromJSONBin();
    switchTab('planner');
}

async function loadFromJSONBin() {
    try {
        let response = await fetch(`https://api.jsonbin.io/v3/b/${JSONBIN_BIN_ID}/latest`, {
            headers: { "X-Master-Key": JSONBIN_API_KEY }
        });
        if (!response.ok) throw new Error("Cloud load failed");
        let result = await response.json();
        if (result.record && result.record.duties) {
            appData = result.record;
            document.getElementById('syncStatusText').textContent = "JSONBin Active";
            document.getElementById('syncSubText').textContent = "Cloud synced";
        }
    } catch (error) {
        console.error("Cloud load error, loading local fallback:", error);
        document.getElementById('syncStatusText').textContent = "Offline Mode";
        document.getElementById('syncSubText').textContent = "Using local backup";
        const saved = localStorage.getItem('pdp_morning_assembly_data');
        if (saved) {
            try { appData = JSON.parse(saved); } catch(e) { console.error(e); }
        }
    }
}

async function saveToStorage() {
    localStorage.setItem('pdp_morning_assembly_data', JSON.stringify(appData));
    
    const badge = document.getElementById('saveBadge');
    if (badge) badge.textContent = "Syncing to cloud...";
    document.getElementById('syncStatusText').textContent = "Syncing...";

    try {
        let response = await fetch(`https://api.jsonbin.io/v3/b/${JSONBIN_BIN_ID}`, {
            method: "PUT",
            headers: {
                "Content-Type": "application/json",
                "X-Master-Key": JSONBIN_API_KEY
            },
            body: JSON.stringify(appData)
        });

        if (!response.ok) throw new Error("Cloud save failed");

        if (badge) badge.textContent = "Synced to cloud";
        document.getElementById('syncStatusText').textContent = "JSONBin Active";
        setTimeout(() => { if (badge) badge.textContent = "All changes saved"; }, 2000);
    } catch (error) {
        console.error("Cloud save error:", error);
        if (badge) badge.textContent = "Saved locally (Offline)";
        document.getElementById('syncStatusText').textContent = "Offline Mode";
    }
}

// SIDEBAR TOGGLE & NAVIGATION FIX
function toggleSidebar() {
    const sidebar = document.getElementById('sidebar');
    const backdrop = document.getElementById('sidebarBackdrop');
    if (!sidebar) return;
    
    const isClosed = sidebar.classList.contains('-translate-x-full');
    if (isClosed) {
        sidebar.classList.remove('-translate-x-full');
        if (backdrop) backdrop.classList.remove('hidden');
    } else {
        sidebar.classList.add('-translate-x-full');
        if (backdrop) backdrop.classList.add('hidden');
    }
}

function switchTab(tabId) {
    // Hide all tab contents
    document.querySelectorAll('.tab-content').forEach(el => el.classList.add('hidden'));
    
    // Remove active style from all sidebar nav buttons
    document.querySelectorAll('.nav-btn').forEach(btn => {
        btn.classList.remove('bg-brand-500', 'text-white', 'shadow-sm');
        btn.classList.add('text-gray-300', 'hover:bg-gray-800', 'hover:text-white');
    });

    // Show target tab
    const targetTab = document.getElementById(`tab-${tabId}`);
    if (targetTab) targetTab.classList.remove('hidden');

    // Activate target sidebar button
    const targetBtn = document.querySelector(`.nav-btn[data-tab="${tabId}"]`);
    if (targetBtn) {
        targetBtn.classList.remove('text-gray-300', 'hover:bg-gray-800', 'hover:text-white');
        targetBtn.classList.add('bg-brand-500', 'text-white', 'shadow-sm');
    }

    // Close mobile sidebar if open
    const sidebar = document.getElementById('sidebar');
    const backdrop = document.getElementById('sidebarBackdrop');
    if (sidebar && !sidebar.classList.contains('-translate-x-full') && window.innerWidth < 1024) {
        sidebar.classList.add('-translate-x-full');
        if (backdrop) backdrop.classList.add('hidden');
    }

    // Render respective tab content
    if (tabId === 'planner') {
        renderPlanner();
    } else if (tabId === 'students') {
        renderStudentsTab();
    } else if (tabId === 'duties') {
        renderDutiesTab();
    }
}

// Get working days (excluding Sundays) for a given year & month
function getWorkingDaysForMonth(year, month) {
    let daysList = [];
    let date = new Date(year, month, 1);
    while (date.getMonth() === month) {
        if (date.getDay() !== 0) { // Exclude Sunday
            daysList.push(new Date(date));
        }
        date.setDate(date.getDate() + 1);
    }
    return daysList;
}

// Split working days into weeks (Monday to Saturday blocks)
function getWeeksForMonth(year, month) {
    const workingDays = getWorkingDaysForMonth(year, month);
    let weeks = [];
    let currentWeek = [];
    
    workingDays.forEach((dObj, idx) => {
        currentWeek.push(dObj);
        // If it's Saturday (6) or last working day of month, push week
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

// FIX: If user explicitly cleared all data, don't auto-regenerate assignments
if (appData._assignmentsCleared) {
if (!appData.assignments[mKey]) appData.assignments[mKey] = {};
return;
}

if (!appData.assignments[mKey]) {
appData.assignments[mKey] = {};
const workingDays = getWorkingDaysForMonth(year, month);
appData.duties.forEach((duty, dIdx) => {
    appData.assignments[mKey][dIdx] = {};
    workingDays.forEach((dObj, dayIndex) => {
        const studentIndex = (dIdx + dayIndex) % appData.students.length;
        appData.assignments[mKey][dIdx][dObj.getDate()] = [appData.students[studentIndex].name];
    });
});
}
}


function changeMonth(direction) {
    currentMonth += direction;
    if (currentMonth > 11) {
        currentMonth = 0;
        currentYear++;
    } else if (currentMonth < 0) {
        currentMonth = 11;
        currentYear--;
    }
    renderPlanner();
}

function renderPlanner() {
    ensureMonthAssignments(currentYear, currentMonth);
    const mKey = getMonthKey(currentYear, currentMonth);
    
    const monthNames = ["January", "February", "March", "April", "May", "June", "July", "August", "September", "October", "November", "December"];
    document.getElementById('monthYearLabel').textContent = `${monthNames[currentMonth]} ${currentYear}`;

    const workingDays = getWorkingDaysForMonth(currentYear, currentMonth);

    // Render Header Row
    const headerRow = document.getElementById('tableHeaderRow');
    let headerHTML = `<th class="p-4 font-bold frozen-header bg-brand-100/90 border-r border-gray-200 w-64 shadow-sm">DUTY / DATE</th>`;
    workingDays.forEach(dObj => {
        const dayNameShort = dObj.toLocaleDateString('en-US', { weekday: 'short' });
        const dateNum = dObj.getDate();
        headerHTML += `<th class="p-4 font-semibold text-center min-w-[150px] border-r border-gray-200">${dayNameShort}<br><span class="text-xs font-bold text-brand-600">${dateNum} ${monthNames[currentMonth].substring(0,3)}</span></th>`;
    });
    headerRow.innerHTML = headerHTML;

    // Render Body Rows
    const tbody = document.getElementById('tableBody');
    let bodyHTML = '';

    appData.duties.forEach((duty, dIdx) => {
        bodyHTML += `<tr class="hover:bg-gray-50/85 transition">`;
        bodyHTML += `<td class="p-4 font-semibold text-gray-800 frozen-col border-r border-gray-200 shadow-sm bg-white">${duty}</td>`;

        workingDays.forEach(dObj => {
            const dayNum = dObj.getDate();
            const assignedList = (appData.assignments[mKey] && 
                                  appData.assignments[mKey][dIdx] && 
                                  appData.assignments[mKey][dIdx][dayNum]) || [];
            
            let studentTagsHTML = '';
            if (assignedList.length === 0) {
                studentTagsHTML = `<span class="text-xs text-gray-400 italic">Unassigned</span>`;
            } else {
                assignedList.forEach(studentName => {
                    const isRed = checkMultipleDutiesSameDay(mKey, dayNum, studentName);
                    const isYellow = checkRepeatedWithin10Days(mKey, dIdx, dayNum, studentName);
                    
                    let indicatorDot = '';
                    if (isRed) indicatorDot = `<span class="w-2 h-2 rounded-full bg-red-500 inline-block ml-1.5 shadow-sm" title="Assigned 2+ duties on this day"></span>`;
                    else if (isYellow) indicatorDot = `<span class="w-2 h-2 rounded-full bg-amber-400 inline-block ml-1.5 shadow-sm" title="Repeated duty in recent rotation"></span>`;

                    // FIX: replaced invalid shadow-2xs with shadow-sm
                    studentTagsHTML += `
                        <div class="inline-flex items-center bg-brand-50 border border-brand-100 text-brand-900 px-2.5 py-1 rounded-lg text-xs font-medium my-0.5 mr-1 shadow-sm">
                            <span>${studentName}</span>
                            ${indicatorDot}
                        </div>
                    `;
                });
            }

            bodyHTML += `
                <td class="p-3 border-r border-gray-200 cursor-pointer hover:bg-brand-50/40 transition align-top" onclick="openCellModal(${currentYear}, ${currentMonth}, ${dayNum}, ${dIdx})">
                    <div class="flex flex-wrap items-center min-h-[40px]">${studentTagsHTML}</div>
                </td>
            `;
        });
        bodyHTML += `</tr>`;
    });
    tbody.innerHTML = bodyHTML;
}

function checkMultipleDutiesSameDay(mKey, dayNum, studentName) {
    let count = 0;
    appData.duties.forEach((_, dIdx) => {
        const list = appData.assignments[mKey]?.[dIdx]?.[dayNum] || [];
        if (list.includes(studentName)) count++;
    });
    return count >= 2;
}

function checkRepeatedWithin10Days(mKey, dutyIdx, dayNum, studentName) {
// Build continuous working-day stream: previous month + current month
let prevYear = currentYear;
let prevMonth = currentMonth - 1;
if (prevMonth < 0) {
prevMonth = 11;
prevYear--;
}

const prevWorkingDays = getWorkingDaysForMonth(prevYear, prevMonth);
const currWorkingDays = getWorkingDaysForMonth(currentYear, currentMonth);
const allWorkingDays = [...prevWorkingDays, ...currWorkingDays];

// Find current day in combined list
const currentFlatIndex = allWorkingDays.findIndex(dObj => 
dObj.getDate() === dayNum && 
dObj.getMonth() === currentMonth && 
dObj.getFullYear() === currentYear
);

if (currentFlatIndex === -1) return false;

let matchCount = 0;
const start = Math.max(0, currentFlatIndex - 9);

for (let i = start; i <= currentFlatIndex; i++) {
const dObj = allWorkingDays[i];
const checkMKey = getMonthKey(dObj.getFullYear(), dObj.getMonth());
const list = appData.assignments[checkMKey]?.[dutyIdx]?.[dObj.getDate()] || [];
if (list.includes(studentName)) matchCount++;
}

return matchCount > 1;
}


// FIX: Complete rewrite of cell modal to use temporary state
function openCellModal(year, month, dayNum, dutyIdx) {
    currentEditingCell = { year, month, day: dayNum, dutyIdx };
    const dutyName = appData.duties[dutyIdx];
    const dObj = new Date(year, month, dayNum);
    const dateStr = dObj.toLocaleDateString('en-US', { weekday: 'long', month: 'long', day: 'numeric', year: 'numeric' });
    
    document.getElementById('modalDutyTitle').textContent = dutyName;
    document.getElementById('modalDaySubtitle').textContent = dateStr;

    // Load current assignments into temporary state
    const mKey = getMonthKey(year, month);
    const existing = appData.assignments[mKey]?.[dutyIdx]?.[dayNum] || [];
    modalTempAssignments = JSON.parse(JSON.stringify(existing));

    renderModalStudentSlots();
    document.getElementById('cellModal').classList.remove('hidden');
}

function cancelCellModal() {
    modalTempAssignments = [];
    document.getElementById('cellModal').classList.add('hidden');
    renderPlanner();
}

function closeCellModal() {
    // This is now only called after explicit save
    modalTempAssignments = [];
    document.getElementById('cellModal').classList.add('hidden');
    renderPlanner();
    saveToStorage();
}

function renderModalStudentSlots() {
    const container = document.getElementById('modalStudentListContainer');
    
    let html = '';
    if (modalTempAssignments.length === 0) {
        html = `<div class="text-xs text-gray-500 italic p-2">No students assigned yet. Click below to add.</div>`;
    } else {
        modalTempAssignments.forEach((studentName, idx) => {
            // FIX: Correct filter logic. Show current slot's selected student + students NOT picked in other slots
            const otherSelected = modalTempAssignments.filter((_, i) => i !== idx);
            const availableStudents = appData.students.filter(s => s.name === studentName || !otherSelected.includes(s.name));

            html += `
                <div class="flex items-center space-x-2 bg-gray-50 p-2.5 rounded-xl border border-gray-200">
                    <select class="modal-student-select flex-1 border border-gray-300 rounded-lg p-2 text-xs bg-white focus:outline-none focus:ring-2 focus:ring-brand-500" data-index="${idx}" onchange="updateStudentSlotSelection(this)">
                        <option value="">-- Select Student --</option>
                        ${availableStudents.map(s => `<option value="${s.name}" ${s.name === studentName ? 'selected' : ''}>${s.name} (${s.class})</option>`).join('')}
                    </select>
                    <button onclick="removeStudentSlot(${idx})" class="w-8 h-8 flex items-center justify-center text-red-500 hover:bg-red-50 rounded-lg" aria-label="Remove student"><i class="fa-solid fa-trash text-xs"></i></button>
                </div>
            `;
        });
    }
    container.innerHTML = html;
}

function updateStudentSlotSelection(selectEl) {
    const idx = parseInt(selectEl.dataset.index);
    const value = selectEl.value;
    if (idx >= 0 && idx < modalTempAssignments.length) {
        modalTempAssignments[idx] = value;
    }
    // FIX: Do NOT re-render entire list on change (prevents focus loss and jank)
    // Only re-render if we need to update other dropdowns' availability.
    // For simplicity, we allow temporarily duplicate selections until re-render,
    // but since we filter options correctly on next render, it's acceptable.
}

function addStudentSlotToCell() {
    const unassigned = appData.students.find(s => !modalTempAssignments.includes(s.name));
    if (unassigned) {
        modalTempAssignments.push(unassigned.name);
    } else if (appData.students.length > 0) {
        modalTempAssignments.push(appData.students[0].name);
    }
    renderModalStudentSlots();
}

function removeStudentSlot(slotIdx) {
    modalTempAssignments.splice(slotIdx, 1);
    renderModalStudentSlots();
}

function saveCellAssignments() {
const selects = document.querySelectorAll('.modal-student-select');
let updatedList = [];
selects.forEach(sel => { if (sel.value) updatedList.push(sel.value); });

updatedList = updatedList.filter(n => n && n.trim() !== '');

const mKey = getMonthKey(currentEditingCell.year, currentEditingCell.month);
if (!appData.assignments[mKey]) appData.assignments[mKey] = {};
if (!appData.assignments[mKey][currentEditingCell.dutyIdx]) appData.assignments[mKey][currentEditingCell.dutyIdx] = {};
appData.assignments[mKey][currentEditingCell.dutyIdx][currentEditingCell.day] = updatedList;

delete appData._assignmentsCleared; // FIX: Re-enable auto-fill for future empty months
closeCellModal();
}


// CLEAR DUTIES MODAL & UNDO LOGIC
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
    if (scope === 'week') {
        weekWrapper.classList.remove('hidden');
    } else {
        weekWrapper.classList.add('hidden');
    }
}

function executeClearDuties() {
    const scope = document.getElementById('clearScopeSelect').value;
    const mKey = getMonthKey(currentYear, currentMonth);
    
    // Backup state for Undo
    lastStateBackup = JSON.parse(JSON.stringify(appData));

    if (scope === 'week') {
        const wIdx = parseInt(document.getElementById('clearWeekSelect').value);
        const weeks = getWeeksForMonth(currentYear, currentMonth);
        const targetWeekDays = weeks[wIdx] || [];
        
        if (appData.assignments[mKey]) {
            appData.duties.forEach((_, dIdx) => {
                if (appData.assignments[mKey][dIdx]) {
                    targetWeekDays.forEach(dObj => {
                        delete appData.assignments[mKey][dIdx][dObj.getDate()];
                    });
                }
            });
        }
        showUndoToast(`Cleared Week ${wIdx + 1} duties.`);
    } else if (scope === 'month') {
        appData.assignments[mKey] = {};
        appData.duties.forEach((_, dIdx) => { appData.assignments[mKey][dIdx] = {}; });
        showUndoToast(`Cleared entire month duties.`);
    } else if (scope === 'all') {
appData.assignments = {};
appData._assignmentsCleared = true; // FIX: Prevent auto-regeneration
showUndoToast(`Cleared all months & data.`);
}


    closeClearDutiesModal();
    saveToStorage();
    renderPlanner();
}

function showUndoToast(msg) {
    const toast = document.getElementById('undoToast');
    document.getElementById('undoToastText').textContent = msg;
    toast.classList.remove('translate-y-24', 'opacity-0');
    setTimeout(() => {
        toast.classList.add('translate-y-24', 'opacity-0');
    }, 7000);
}

function triggerUndo() {
    if (lastStateBackup) {
        appData = JSON.parse(JSON.stringify(lastStateBackup));
        lastStateBackup = null;
        saveToStorage();
        renderPlanner();
        const toast = document.getElementById('undoToast');
        toast.classList.add('translate-y-24', 'opacity-0');
    }
}

function renderStudentsTab() {
    const container = document.getElementById('studentsGridList');
    if (!container) return;
    let html = '';
    appData.students.forEach((student, idx) => {
        // FIX: replaced invalid shadow-2xs with shadow-sm
        html += `
            <div class="bg-gray-50 p-4 rounded-2xl border border-gray-200 flex items-center justify-between shadow-sm">
                <div class="flex items-center space-x-3">
                    <span class="text-xs font-bold text-gray-400 w-6">#${idx + 1}</span>
                    <div>
                        <p class="font-bold text-sm text-gray-900">${student.name}</p>
                        <p class="text-xs text-gray-500">${student.class}</p>
                    </div>
                </div>
                <div class="flex items-center space-x-1">
                    <button onclick="moveStudent(${idx}, -1)" ${idx === 0 ? 'disabled class="text-gray-200 p-2 cursor-not-allowed"' : 'class="text-gray-500 hover:text-brand-600 p-2"'} title="Move Up" aria-label="Move up"><i class="fa-solid fa-arrow-up text-xs"></i></button>
                    <button onclick="moveStudent(${idx}, 1)" ${idx === appData.students.length - 1 ? 'disabled class="text-gray-200 p-2 cursor-not-allowed"' : 'class="text-gray-500 hover:text-brand-600 p-2"'} title="Move Down" aria-label="Move down"><i class="fa-solid fa-arrow-down text-xs"></i></button>
                    <button onclick="deleteStudent(${idx})" class="text-gray-400 hover:text-red-500 p-2 ml-2" title="Delete" aria-label="Delete"><i class="fa-solid fa-trash text-xs"></i></button>
                </div>
            </div>
        `;
    });
    container.innerHTML = html;
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
    const name = prompt("Enter Student Full Name:");
    if (!name) return;
    const cls = prompt("Enter Student Class / Section:", "Class 6R");
    appData.students.push({ id: Date.now(), name, class: cls || "Class 6R" });
    saveToStorage();
    renderStudentsTab();
}

// FIX: When deleting a student, remove them from all assignments across all months
function deleteStudent(idx) {
    if (!confirm("Remove this student? This will also unassign them from all duties.")) return;
    const removedName = appData.students[idx].name;
    appData.students.splice(idx, 1);
    
    // Cleanup all assignments
    Object.keys(appData.assignments).forEach(mKey => {
        if (!appData.assignments[mKey]) return;
        Object.keys(appData.assignments[mKey]).forEach(dIdx => {
            if (!appData.assignments[mKey][dIdx]) return;
            Object.keys(appData.assignments[mKey][dIdx]).forEach(dayNum => {
                const list = appData.assignments[mKey][dIdx][dayNum];
                if (Array.isArray(list)) {
                    appData.assignments[mKey][dIdx][dayNum] = list.filter(n => n !== removedName);
                }
            });
        });
    });
    
    saveToStorage();
    renderStudentsTab();
    if (!document.getElementById('tab-planner').classList.contains('hidden')) {
        renderPlanner();
    }
}

function renderDutiesTab() {
    const container = document.getElementById('dutiesListContainer');
    if (!container) return;
    let html = '';
    appData.duties.forEach((duty, idx) => {
        html += `
            <div class="bg-gray-50 p-4 rounded-2xl border border-gray-200 flex items-center justify-between">
                <div class="flex items-center space-x-3">
                    <span class="w-7 h-7 rounded-lg bg-brand-100 text-brand-900 flex items-center justify-center font-bold text-xs">${idx + 1}</span>
                    <span class="font-semibold text-sm text-gray-900">${duty}</span>
                </div>
                <div class="flex items-center space-x-1">
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
    
    const tempDuty = appData.duties[idx];
    appData.duties[idx] = appData.duties[targetIdx];
    appData.duties[targetIdx] = tempDuty;

    Object.keys(appData.assignments).forEach(mKey => {
        if (appData.assignments[mKey]) {
            const tempAssign = appData.assignments[mKey][idx];
            appData.assignments[mKey][idx] = appData.assignments[mKey][targetIdx];
            appData.assignments[mKey][targetIdx] = tempAssign;
        }
    });

    saveToStorage();
    renderDutiesTab();
    renderPlanner();
}

function openDutyModal() {
    const dutyName = prompt("Enter New Assembly Duty Title:");
    if (!dutyName) return;
    appData.duties.push(dutyName);
    const newIdx = appData.duties.length - 1;
    Object.keys(appData.assignments).forEach(mKey => {
        if (!appData.assignments[mKey]) appData.assignments[mKey] = {};
        appData.assignments[mKey][newIdx] = {};
    });
    saveToStorage();
    renderDutiesTab();
    renderPlanner();
}

// FIX: Hardened duty deletion with proper numeric key sorting
function deleteDuty(idx) {
    if (!confirm("Delete this duty?")) return;
    appData.duties.splice(idx, 1);
    Object.keys(appData.assignments).forEach(mKey => {
        if (appData.assignments[mKey]) {
            delete appData.assignments[mKey][idx];
            let newMonthMap = {};
            let newIdx = 0;
            Object.keys(appData.assignments[mKey])
                .map(k => parseInt(k))
                .sort((a, b) => a - b)
                .forEach(oldKey => {
                    newMonthMap[newIdx++] = appData.assignments[mKey][oldKey];
                });
            appData.assignments[mKey] = newMonthMap;
        }
    });
    saveToStorage();
    renderDutiesTab();
    renderPlanner();
}

// CLEAN VIEW WITH WEEK FILTERING FIX & DUTY COLUMN VISIBILITY
function openCleanViewModal() {
    const monthNames = ["January", "February", "March", "April", "May", "June", "July", "August", "September", "October", "November", "December"];
    document.getElementById('cleanViewTitle').textContent = `Morning Assembly Duty Schedule - ${monthNames[currentMonth]} ${currentYear}`;
    
    // Populate Week Checkboxes
    const weeks = getWeeksForMonth(currentYear, currentMonth);
    const weekContainer = document.getElementById('cleanWeekCheckboxesContainer');
    let weekChkHtml = '';
    weeks.forEach((wk, wIdx) => {
        const firstDate = wk[0].getDate();
        const lastDate = wk[wk.length - 1].getDate();
        weekChkHtml += `<label class="cursor-pointer px-2.5 py-1 rounded bg-gray-700 text-white hover:bg-gray-600 whitespace-nowrap select-none"><input type="checkbox" class="clean-week-chk mr-1" value="${wIdx}" checked onchange="renderCleanTable()"> Wk ${wIdx + 1} (${firstDate}-${lastDate})</label>`;
    });
    weekContainer.innerHTML = weekChkHtml;

    // Reset weekday selection to all working days
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
    
    [1, 2, 3, 4, 5, 6].forEach(dayNum => { // Mon to Sat
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

    const weeks = getWeeksForMonth(currentYear, currentMonth);
    const mKey = getMonthKey(currentYear, currentMonth);
    
    // Build list of visible days: in selected weeks AND selected weekdays
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

    // Sort by date
    visibleDays.sort((a, b) => a - b);

    let html = `<thead><tr class="bg-gray-100 border-b"><th class="p-3 border-r font-bold w-48 bg-gray-50" style="position:sticky;left:0;z-index:20;background:#f9fafb;">DUTY / DATE</th>`;
    visibleDays.forEach(dObj => {
        const dayStr = dObj.toLocaleDateString('en-US', { weekday: 'short', month: 'short', day: 'numeric' });
        html += `<th class="p-3 border-r font-bold text-center min-w-[120px] whitespace-nowrap">${dayStr}</th>`;
    });
    html += `</tr></thead><tbody class="divide-y">`;

    appData.duties.forEach((duty, dIdx) => {
        html += `<tr><td class="p-3 border-r font-semibold bg-gray-50 text-gray-900" style="position:sticky;left:0;z-index:10;background:#fff;">${duty}</td>`;
        visibleDays.forEach(dObj => {
            const dateNum = dObj.getDate();
            const list = appData.assignments[mKey]?.[dIdx]?.[dateNum] || [];
            html += `<td class="p-3 border-r text-sm text-gray-700 whitespace-nowrap">${list.join(', ') || '-'}</td>`;
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


// FIX: Export dates in comma-safe format to prevent broken CSV headers
function exportCSV() {
    const mKey = getMonthKey(currentYear, currentMonth);
    const workingDays = getWorkingDaysForMonth(currentYear, currentMonth);
    
    let csvRows = [];
    let header = ["Duty", ...workingDays.map(dObj => {
        const d = dObj;
        return `${String(d.getDate()).padStart(2,'0')}-${["Jan","Feb","Mar","Apr","May","Jun","Jul","Aug","Sep","Oct","Nov","Dec"][d.getMonth()]}-${d.getFullYear()}`;
    })];
    csvRows.push(header.join(','));

    appData.duties.forEach((duty, dIdx) => {
        let row = [`"${duty}"`];
        workingDays.forEach(dObj => {
            let students = appData.assignments[mKey]?.[dIdx]?.[dObj.getDate()] || [];
            row.push(`"${students.join(';')}"`);
        });
        csvRows.push(row.join(','));
    });

    const blob = new Blob([csvRows.join('\n')], { type: 'text/csv' });
    const url = window.URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.setAttribute('href', url);
    a.setAttribute('download', `pdp_morning_assembly_${mKey}.csv`);
    a.click();
    window.URL.revokeObjectURL(url);
}

// FIX: Robust CSV line parser that handles quotes and commas correctly
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
    return result.map(v => v.replace(/^"(.*)"$/, '$1'));
}

function importCSV() {
const fileInput = document.getElementById('csvFileInput');
if (!fileInput.files.length) { alert("Please select a CSV file first."); return; }
const file = fileInput.files[0];
const reader = new FileReader();

reader.onload = function(e) {
let text = e.target.result;
if (text.charCodeAt(0) === 0xFEFF) text = text.substring(1);
const lines = text.split(/\r\n|\n/);
if (lines.length < 2) {
    alert("Invalid CSV format.");
    return;
}

// Parse header row to extract real dates
const headerCols = parseCSVLine(lines[0]);
if (headerCols.length < 2) {
    alert("Invalid CSV header.");
    return;
}

let columnDates = []; // {year, month, day, mKey}
for (let c = 1; c < headerCols.length; c++) {
    const parsed = parseCSVDate(headerCols[c].trim());
    columnDates.push(parsed);
}

if (columnDates.every(d => d === null)) {
    alert("Could not parse any dates from CSV header.\nExpected format: 01-Jul-2026");
    return;
}

// Backup for undo
lastStateBackup = JSON.parse(JSON.stringify(appData));

let unmatchedDuties = [];
let importedCount = 0;

for (let i = 1; i < lines.length; i++) {
    if (!lines[i].trim()) continue;
    const cols = parseCSVLine(lines[i]);
    if (cols.length === 0) continue;

    let dutyName = cols[0].trim();
    let dutyIdx = findDutyIndex(dutyName);
    
    if (dutyIdx === -1) {
        unmatchedDuties.push(dutyName);
        continue;
    }

    importedCount++;

    for (let c = 1; c < cols.length && c - 1 < columnDates.length; c++) {
        const dateInfo = columnDates[c - 1];
        if (!dateInfo) continue;

        let cellVal = cols[c] || '';
        let students = cellVal ? cellVal.split(';').map(s => s.trim()).filter(s => s) : [];

        if (!appData.assignments[dateInfo.mKey]) appData.assignments[dateInfo.mKey] = {};
        if (!appData.assignments[dateInfo.mKey][dutyIdx]) appData.assignments[dateInfo.mKey][dutyIdx] = {};
        appData.assignments[dateInfo.mKey][dutyIdx][dateInfo.day] = students;
    }
}

if (unmatchedDuties.length > 0) {
    alert("Could not match these duties:\n• " + unmatchedDuties.join("\n• ") + "\n\nPlease check spelling or add them in the Duties tab.");
}

if (importedCount === 0) {
    alert("No valid duty rows found in CSV.");
    return;
}

delete appData._assignmentsCleared;
saveToStorage();
renderPlanner();
showUndoToast(`Imported ${importedCount} duty rows successfully.`);
};

reader.readAsText(file);
}

// Parse "01-Jul-2026", "Jul 1, 2026", or "2026-07-01" from CSV header
function parseCSVDate(str) {
if (!str) return null;
str = str.trim();
const months = {jan:0, feb:1, mar:2, apr:3, may:4, jun:5, jul:6, aug:7, sep:8, oct:9, nov:10, dec:11};

// 01-Jul-2026
let m = str.match(/^(\d{1,2})-([A-Za-z]{3})-(\d{4})$/);
if (m) {
const mon = months[m[2].toLowerCase()];
if (mon !== undefined) {
    return { year: parseInt(m[3]), month: mon, day: parseInt(m[1]), mKey: `${m[3]}-${String(mon+1).padStart(2,'0')}` };
}
}

// Jul 1, 2026
m = str.match(/^([A-Za-z]{3})\s+(\d{1,2}),\s*(\d{4})$/);
if (m) {
const mon = months[m[1].toLowerCase()];
if (mon !== undefined) {
    return { year: parseInt(m[3]), month: mon, day: parseInt(m[2]), mKey: `${m[3]}-${String(mon+1).padStart(2,'0')}` };
}
}

// 2026-07-01
m = str.match(/^(\d{4})-(\d{2})-(\d{2})$/);
if (m) {
const year = parseInt(m[1]), month = parseInt(m[2]) - 1, day = parseInt(m[3]);
return { year, month, day, mKey: `${year}-${String(month+1).padStart(2,'0')}` };
}

return null;
}

// Fuzzy duty matcher: handles & vs "and", extra spaces, case differences
function findDutyIndex(name) {
if (!name) return -1;
const normalize = s => s.toLowerCase().replace(/&/g, 'and').replace(/\s+/g, ' ').trim();
const target = normalize(name);

// Exact normalized match
let idx = appData.duties.findIndex(d => normalize(d) === target);
if (idx !== -1) return idx;

// One contains the other
idx = appData.duties.findIndex(d => {
const dn = normalize(d);
return dn.includes(target) || target.includes(dn);
});
return idx;
}


// FIX: Keyboard ESC closes modals
document.addEventListener('keydown', (e) => {
    if (e.key === 'Escape') {
        if (!document.getElementById('cellModal').classList.contains('hidden')) cancelCellModal();
        if (!document.getElementById('clearDutiesModal').classList.contains('hidden')) closeClearDutiesModal();
        if (!document.getElementById('cleanViewModal').classList.contains('hidden')) closeCleanViewModal();
    }
});

window.onload = async () => {
    await initApp();
};
