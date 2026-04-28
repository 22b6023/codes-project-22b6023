const SEMESTER_LABELS = {
  1: "Y1S1",
  2: "Y1S2",
  3: "Y2S1",
  4: "Y2S2",
  5: "Y3S1",
  6: "Y3S2",
  7: "Y4S1",
  8: "Y4S2"
};

const semesterSections = document.getElementById("semesterSections");
const predictBtn = document.getElementById("predictBtn");
const sampleHighBtn = document.getElementById("sampleHighBtn");
const sampleModerateBtn = document.getElementById("sampleModerateBtn");
const sampleLowBtn = document.getElementById("sampleLowBtn");
const clearBtn = document.getElementById("clearBtn");
const predictSemesterXSelect = document.getElementById("predictSemesterX");

let gpaTrendChart = null;
let wavgTrendChart = null;

let batchRiskDistributionChart = null;
let batchRiskBySemesterChart = null;
let batchGpaByMajorChart = null;
let batchWavgTrendChart = null;

let batchResultsCache = [];
let currentBatchFilter = "All";

/* =========================
   STUDENT VIEW
========================= */

function getPredictSemesterX() {
  return parseInt(predictSemesterXSelect.value, 10);
}

function updateScopeDisplay() {
  const x = getPredictSemesterX();
  document.getElementById("scopeDisplay").value = `Semester 1 to ${x - 1}`;
}

function createSemesterCards() {
  semesterSections.innerHTML = "";

  const x = getPredictSemesterX();

  for (let semNum = 1; semNum < x; semNum++) {
    const semesterLabel = SEMESTER_LABELS[semNum];

    const card = document.createElement("div");
    card.className = "semester-card";
    card.innerHTML = `
      <div class="semester-top">
        <div>
          <h2 class="semester-title">Semester ${semNum}</h2>
          <p class="hero-text">Enter GPA and module records for ${semesterLabel}.</p>
        </div>
        <div class="gpa-box field">
          <label for="gpa_${semNum}">GPA ${semesterLabel}</label>
          <input type="number" step="0.01" id="gpa_${semNum}" placeholder="e.g. 3.25" />
        </div>
      </div>

      <div class="table-wrap">
        <table class="module-table">
          <thead>
            <tr>
              <th>Module Code</th>
              <th>Credits (MC)</th>
              <th>Marks</th>
              <th>Action</th>
            </tr>
          </thead>
          <tbody id="tbody_${semNum}"></tbody>
        </table>
      </div>

      <button class="add-row-btn" data-semester="${semNum}">Add Module</button>
    `;
    semesterSections.appendChild(card);

    addModuleRow(semNum);
    addModuleRow(semNum);
  }

  document.querySelectorAll(".add-row-btn").forEach((btn) => {
    btn.addEventListener("click", () => addModuleRow(parseInt(btn.dataset.semester, 10)));
  });
}

function addModuleRow(semNum, values = {}) {
  const tbody = document.getElementById(`tbody_${semNum}`);
  if (!tbody) return;

  const tr = document.createElement("tr");

  tr.innerHTML = `
    <td><input type="text" class="module-code" placeholder="e.g. DS-1203" value="${values.module_code || ""}" /></td>
    <td><input type="number" step="1" class="module-mc" placeholder="e.g. 4" value="${values.mc || ""}" /></td>
    <td><input type="number" step="0.01" class="module-marks" placeholder="e.g. 68" value="${values.marks || ""}" /></td>
    <td><button class="remove-row-btn" type="button">Remove</button></td>
  `;

  tr.querySelector(".remove-row-btn").addEventListener("click", () => {
    tr.remove();
  });

  tbody.appendChild(tr);
}

function parseModuleCode(moduleCode) {
  if (!moduleCode) return { level: null, type: null };

  const parts = String(moduleCode).trim().split("-");
  if (parts.length < 2 || parts[1].length < 2) {
    return { level: null, type: null };
  }

  const codePart = parts[1].trim();
  const level = parseInt(codePart[0], 10);
  const type = parseInt(codePart[1], 10);

  return {
    level: Number.isNaN(level) ? null : level,
    type: Number.isNaN(type) ? null : type
  };
}

function safeNumber(value) {
  const n = parseFloat(value);
  return Number.isNaN(n) ? 0 : n;
}

function computeWeightedAverage(items) {
  const valid = items.filter((item) => item.mc > 0);
  if (!valid.length) return 0;

  const totalWeighted = valid.reduce((sum, item) => sum + item.marks * item.mc, 0);
  const totalCredits = valid.reduce((sum, item) => sum + item.mc, 0);

  return totalCredits > 0 ? totalWeighted / totalCredits : 0;
}

function computeSemesterFeatures(modules, gpa, semNum) {
  const semesterLabel = SEMESTER_LABELS[semNum];

  const valid = modules
    .map((m) => ({
      module_code: String(m.module_code || "").trim(),
      mc: safeNumber(m.mc),
      marks: safeNumber(m.marks)
    }))
    .filter((m) => m.module_code && m.mc > 0);

  const marks = valid.map((m) => m.marks);

  const avg_mark = valid.length ? marks.reduce((a, b) => a + b, 0) / valid.length : 0;
  const mark_min = valid.length ? Math.min(...marks) : 0;
  const mark_max = valid.length ? Math.max(...marks) : 0;

  let mark_std = 0;
  if (valid.length) {
    const variance =
      marks.reduce((sum, mark) => sum + Math.pow(mark - avg_mark, 2), 0) / valid.length;
    mark_std = Math.sqrt(variance);
  }

  const features = {
    [`GPA_${semesterLabel}`]: safeNumber(gpa),
    [`wavg_mark_${semesterLabel}`]: computeWeightedAverage(valid),
    [`avg_mark_${semesterLabel}`]: avg_mark,
    [`mark_min_${semesterLabel}`]: mark_min,
    [`mark_max_${semesterLabel}`]: mark_max,
    [`mark_std_${semesterLabel}`]: mark_std
  };

  for (let level = 1; level <= 4; level++) {
    const levelModules = valid.filter((m) => parseModuleCode(m.module_code).level === level);
    features[`wavg_mark_L${level}_${semesterLabel}`] = computeWeightedAverage(levelModules) || 0;
  }

  for (let type = 1; type <= 5; type++) {
    const typeModules = valid.filter((m) => parseModuleCode(m.module_code).type === type);
    features[`wavg_mark_T${type}_${semesterLabel}`] = computeWeightedAverage(typeModules) || 0;
  }

  return features;
}

function collectRawInput() {
  const x = getPredictSemesterX();

  const payload = {
    student_id: document.getElementById("studentId").value.trim(),
    major: document.getElementById("programme").value.trim(),
    predict_semester_x: x,
    semesters: {}
  };

  for (let semNum = 1; semNum < x; semNum++) {
    const gpa = safeNumber(document.getElementById(`gpa_${semNum}`)?.value);
    const rows = document.querySelectorAll(`#tbody_${semNum} tr`);

    const modules = Array.from(rows).map((row) => ({
      module_code: row.querySelector(".module-code").value.trim(),
      mc: row.querySelector(".module-mc").value,
      marks: row.querySelector(".module-marks").value
    }));

    payload.semesters[String(semNum)] = { gpa, modules };
  }

  return payload;
}

function computeAllFeaturesPreview(payload) {
  let featureMap = {};
  const x = payload.predict_semester_x;

  for (let semNum = 1; semNum < x; semNum++) {
    const semData = payload.semesters[String(semNum)];
    const semesterFeatures = computeSemesterFeatures(semData.modules, semData.gpa, semNum);
    featureMap = { ...featureMap, ...semesterFeatures };
  }

  return featureMap;
}

function getLatestHistoricalSemesterNumber(x) {
  return x - 1;
}

function getLatestHistoricalLabel(x) {
  return SEMESTER_LABELS[getLatestHistoricalSemesterNumber(x)];
}

function buildSemesterOverview(payload, features) {
  const container = document.getElementById("semesterOverviewCards");
  const x = payload.predict_semester_x;

  container.innerHTML = Array.from({ length: x - 1 }, (_, i) => i + 1).map((semNum) => {
    const semesterLabel = SEMESTER_LABELS[semNum];
    const modules = payload.semesters[String(semNum)]?.modules || [];
    const validCount = modules.filter(
      (m) => String(m.module_code || "").trim() && safeNumber(m.mc) > 0
    ).length;

    return `
      <div class="overview-item">
        <h4>Semester ${semNum} (${semesterLabel})</h4>
        <div class="overview-mini">
          <div>
            <small>GPA</small>
            <strong>${(features[`GPA_${semesterLabel}`] ?? 0).toFixed(2)}</strong>
          </div>
          <div>
            <small>Modules</small>
            <strong>${validCount}</strong>
          </div>
          <div>
            <small>WAVG Mark</small>
            <strong>${(features[`wavg_mark_${semesterLabel}`] ?? 0).toFixed(2)}</strong>
          </div>
          <div>
            <small>Min / Max</small>
            <strong>${(features[`mark_min_${semesterLabel}`] ?? 0).toFixed(1)} / ${(features[`mark_max_${semesterLabel}`] ?? 0).toFixed(1)}</strong>
          </div>
        </div>
      </div>
    `;
  }).join("");
}

function renderFeaturePreview(features) {
  const body = document.getElementById("featurePreviewBody");
  const previewEntries = Object.entries(features);

  body.innerHTML = previewEntries.length
    ? previewEntries
        .map(([key, value]) => `<tr><td>${key}</td><td>${Number(value).toFixed(4)}</td></tr>`)
        .join("")
    : '<tr><td colspan="2" class="empty-note">No features computed yet.</td></tr>';
}

function renderQuickOverview(features, x) {
  const latestLabel = getLatestHistoricalLabel(x);

  document.getElementById("summaryLatestGpa").textContent = (features[`GPA_${latestLabel}`] ?? 0).toFixed(2);
  document.getElementById("summaryLatestWavg").textContent = (features[`wavg_mark_${latestLabel}`] ?? 0).toFixed(2);
  document.getElementById("summaryLatestMin").textContent = (features[`mark_min_${latestLabel}`] ?? 0).toFixed(2);
  document.getElementById("summaryLatestMax").textContent = (features[`mark_max_${latestLabel}`] ?? 0).toFixed(2);
}

function renderGpaTrend(features, x) {
  const semNums = Array.from({ length: x - 1 }, (_, i) => i + 1);
  const labels = semNums.map((n) => `S${n}`);
  const data = semNums.map((n) => features[`GPA_${SEMESTER_LABELS[n]}`] ?? 0);

  if (gpaTrendChart) gpaTrendChart.destroy();

  const ctx = document.getElementById("gpaTrendChart");
  gpaTrendChart = new Chart(ctx, {
    type: "line",
    data: {
      labels,
      datasets: [{
        label: "GPA",
        data,
        borderColor: "#4f7cff",
        backgroundColor: "rgba(79, 124, 255, 0.12)",
        fill: true,
        tension: 0.35,
        pointRadius: 4,
        pointHoverRadius: 5
      }]
    },
    options: {
      responsive: true,
      maintainAspectRatio: false,
      plugins: { legend: { display: false } },
      scales: {
        x: { grid: { display: false } },
        y: { beginAtZero: true, max: 4, grid: { color: "#e6eef7" } }
      }
    }
  });
}

function renderWavgTrend(features, x) {
  const semNums = Array.from({ length: x - 1 }, (_, i) => i + 1);
  const labels = semNums.map((n) => `S${n}`);
  const data = semNums.map((n) => features[`wavg_mark_${SEMESTER_LABELS[n]}`] ?? 0);

  if (wavgTrendChart) wavgTrendChart.destroy();

  const ctx = document.getElementById("wavgTrendChart");
  wavgTrendChart = new Chart(ctx, {
    type: "line",
    data: {
      labels,
      datasets: [{
        label: "Weighted Mark",
        data,
        borderColor: "#2fa56f",
        backgroundColor: "rgba(47, 165, 111, 0.12)",
        fill: true,
        tension: 0.35,
        pointRadius: 4,
        pointHoverRadius: 5
      }]
    },
    options: {
      responsive: true,
      maintainAspectRatio: false,
      plugins: { legend: { display: false } },
      scales: {
        x: { grid: { display: false } },
        y: { beginAtZero: true, grid: { color: "#e6eef7" } }
      }
    }
  });
}

function computeWeakAreas(features, x) {
  const latestLabel = getLatestHistoricalLabel(x);

  const levelEntries = [1, 2, 3, 4].map((level) => ({
    label: `L${level}`,
    value: safeNumber(features[`wavg_mark_L${level}_${latestLabel}`])
  }));

  const typeEntries = [1, 2, 3, 4, 5].map((type) => ({
    label: `T${type}`,
    value: safeNumber(features[`wavg_mark_T${type}_${latestLabel}`])
  }));

  const nonZeroLevels = levelEntries.filter((x) => x.value > 0);
  const nonZeroTypes = typeEntries.filter((x) => x.value > 0);

  const weakestLevel = nonZeroLevels.length
    ? nonZeroLevels.reduce((a, b) => (a.value <= b.value ? a : b))
    : { label: "-", value: 0 };

  const weakestType = nonZeroTypes.length
    ? nonZeroTypes.reduce((a, b) => (a.value <= b.value ? a : b))
    : { label: "-", value: 0 };

  return { weakestLevel, weakestType, levelEntries, typeEntries };
}

function renderWeakAreas(features, x) {
  const { weakestLevel, weakestType, levelEntries, typeEntries } = computeWeakAreas(features, x);

  document.getElementById("weakestLevelDisplay").textContent =
    weakestLevel.label === "-" ? "-" : `${weakestLevel.label} (${weakestLevel.value.toFixed(2)})`;

  document.getElementById("weakestTypeDisplay").textContent =
    weakestType.label === "-" ? "-" : `${weakestType.label} (${weakestType.value.toFixed(2)})`;

  const breakdown = document.getElementById("weakAreaBreakdown");
  breakdown.innerHTML = `
    <div class="overview-item">
      <h4>Module Level Breakdown</h4>
      <div class="overview-mini">
        ${levelEntries.map((item) => `
          <div>
            <small>${item.label}</small>
            <strong>${item.value.toFixed(2)}</strong>
          </div>
        `).join("")}
      </div>
    </div>
    <div class="overview-item">
      <h4>Module Type Breakdown</h4>
      <div class="overview-mini">
        ${typeEntries.map((item) => `
          <div>
            <small>${item.label}</small>
            <strong>${item.value.toFixed(2)}</strong>
          </div>
        `).join("")}
      </div>
    </div>
  `;
}

function getMeaning(risk) {
  if (risk === "High Risk") {
    return "Your academic pattern shows strong warning signs and may require urgent support.";
  }
  if (risk === "Moderate Risk") {
    return "Your academic pattern shows some warning indicators that should be monitored carefully.";
  }
  return "Your academic pattern currently appears stable based on the available semester data.";
}

function renderTimeline(x, prediction) {
  const container = document.getElementById("predictionTimeline");

  const items = [];
  for (let semNum = 1; semNum < x; semNum++) {
    items.push(`
      <div class="overview-item">
        <h4>Semester ${semNum}</h4>
        <div class="overview-mini">
          <div>
            <small>Status</small>
            <strong>History Entered</strong>
          </div>
          <div>
            <small>Checkpoint</small>
            <strong>${SEMESTER_LABELS[semNum]}</strong>
          </div>
        </div>
      </div>
    `);
  }

  items.push(`
    <div class="overview-item">
      <h4>Semester ${x}</h4>
      <div class="overview-mini">
        <div>
          <small>Status</small>
          <strong>Predicted</strong>
        </div>
        <div>
          <small>Risk Level</small>
          <strong>${prediction}</strong>
        </div>
      </div>
    </div>
  `);

  container.innerHTML = items.join("");
}

function renderPrediction(result, payload) {
  const resultState = document.getElementById("resultState");
  const resultContent = document.getElementById("resultContent");
  const riskLabel = document.getElementById("riskLabel");
  const riskBadge = document.getElementById("riskBadge");
  const riskRecommendation = document.getElementById("riskRecommendation");
  const studentDisplay = document.getElementById("studentDisplay");
  const riskMeaning = document.getElementById("riskMeaning");
  const predictionPointDisplay = document.getElementById("predictionPointDisplay");
  const checkpointUsedDisplay = document.getElementById("checkpointUsedDisplay");

  resultState.classList.add("hidden");
  resultContent.classList.remove("hidden");

  riskLabel.textContent = result.prediction;
  riskBadge.textContent = result.prediction;
  studentDisplay.textContent = `${payload.student_id || "-"} (${payload.major || "-"})`;
  riskRecommendation.textContent = result.recommendation || "-";
  riskMeaning.textContent = getMeaning(result.prediction);
  predictionPointDisplay.textContent = `Semester ${result.predict_semester_x}`;
  checkpointUsedDisplay.textContent = result.model_checkpoint_used || "-";

  riskBadge.className = "risk-badge";
  if (result.prediction === "High Risk") {
    riskBadge.classList.add("risk-high");
  } else if (result.prediction === "Moderate Risk") {
    riskBadge.classList.add("risk-moderate");
  } else {
    riskBadge.classList.add("risk-low");
  }

  document.getElementById("studentDashboardOutput").scrollIntoView({
  behavior: "smooth",
  block: "start"
});

  renderTimeline(result.predict_semester_x, result.prediction);
}

function resetStudentVisuals() {
  document.getElementById("summaryLatestGpa").textContent = "-";
  document.getElementById("summaryLatestWavg").textContent = "-";
  document.getElementById("summaryLatestMin").textContent = "-";
  document.getElementById("summaryLatestMax").textContent = "-";

  document.getElementById("featurePreviewBody").innerHTML =
    '<tr><td colspan="2" class="empty-note">No features computed yet.</td></tr>';

  document.getElementById("semesterOverviewCards").innerHTML =
    '<div class="empty-note">No semester summary yet.</div>';

  document.getElementById("predictionTimeline").innerHTML =
    '<div class="empty-note">No timeline yet.</div>';

  document.getElementById("weakestLevelDisplay").textContent = "-";
  document.getElementById("weakestTypeDisplay").textContent = "-";
  document.getElementById("weakAreaBreakdown").innerHTML =
    '<div class="empty-note">No weak area summary yet.</div>';

  document.getElementById("resultState").classList.remove("hidden");
  document.getElementById("resultContent").classList.add("hidden");

  if (gpaTrendChart) {
    gpaTrendChart.destroy();
    gpaTrendChart = null;
  }

  if (wavgTrendChart) {
    wavgTrendChart.destroy();
    wavgTrendChart = null;
  }
}

function loadSampleDataForX(x, profileName = "Moderate Risk") {
  document.getElementById("studentId").value = "SAMPLE";
  document.getElementById("programme").value = "Sample Major";
  predictSemesterXSelect.value = String(x);

  updateScopeDisplay();
  createSemesterCards();

  const SAMPLE_PROFILES = {
    "High Risk": {
      1: {
        gpa: 2.13,
        modules: [
          { module_code: "AW-2309", mc: 4, marks: 53.1 },
          { module_code: "BA-1101", mc: 4, marks: 57 },
          { module_code: "LE-1503", mc: 4, marks: 52.3 },
          { module_code: "PB-1501", mc: 4, marks: 64.8 }
        ]
      },
      2: {
        gpa: 2.7,
        modules: [
          { module_code: "PB-2312", mc: 4, marks: 88 },
          { module_code: "LE-2503", mc: 4, marks: 59.5 },
          { module_code: "AW-1304", mc: 4, marks: 64.5 },
          { module_code: "AW-1202", mc: 4, marks: 66.5 },
          { module_code: "AW-2301", mc: 4, marks: 43.6 }
        ]
      },
      3: {
        gpa: 2.4,
        modules: [
          { module_code: "AW-2314", mc: 4, marks: 53 },
          { module_code: "AW-3302", mc: 4, marks: 58.2 },
          { module_code: "AW-1201", mc: 4, marks: 71.1 },
          { module_code: "AW-2201", mc: 4, marks: 54.3 },
          { module_code: "AW-2302", mc: 4, marks: 58 }
        ]
      },
      4: {
        gpa: 3.07,
        modules: [
          { module_code: "AW-2305", mc: 4, marks: 78 },
          { module_code: "AW-3306", mc: 4, marks: 74.5 },
          { module_code: "AW-4305", mc: 4, marks: 64.8 },
          { module_code: "MS-1501", mc: 4, marks: 56 },
          { module_code: "SC-1483", mc: 4, marks: 56.4 },
          { module_code: "SP-3407", mc: 4, marks: 65.3 }
        ]
      },
      5: {
        gpa: 0,
        modules: [
          { module_code: "DW-3001", mc: 16, marks: 85 }
        ]
      },
      6: {
        gpa: 0,
        modules: [
          { module_code: "SUS-310", mc: 4, marks: 0 }
        ]
      },
      7: {
        gpa: 2.71,
        modules: [
          { module_code: "AW-4307", mc: 4, marks: 59.2 },
          { module_code: "AW-4310", mc: 4, marks: 75.8 },
          { module_code: "AW-3308", mc: 4, marks: 75 },
          { module_code: "AW-4201", mc: 0, marks: 0 },
          { module_code: "AW-4302", mc: 4, marks: 50 }
        ]
      }
    },

    "Moderate Risk": {
      1: {
        gpa: 2.63,
        modules: [
          { module_code: "PB-1501", mc: 4, marks: 73 },
          { module_code: "LE-1503", mc: 4, marks: 66.3 },
          { module_code: "AH-2309", mc: 4, marks: 51.2 },
          { module_code: "AH-1201", mc: 4, marks: 67.3 }
        ]
      },
      2: {
        gpa: 2.67,
        modules: [
          { module_code: "AH-2310", mc: 4, marks: 70.4 },
          { module_code: "SM-1402", mc: 0, marks: 39.2 },
          { module_code: "LE-2503", mc: 4, marks: 64.5 },
          { module_code: "AH-2311", mc: 4, marks: 61 },
          { module_code: "AH-1202", mc: 4, marks: 73.9 }
        ]
      },
      3: {
        gpa: 3.1,
        modules: [
          { module_code: "MS-1501", mc: 4, marks: 67 },
          { module_code: "AH-1301", mc: 4, marks: 78.2 },
          { module_code: "AH-2201", mc: 4, marks: 62.2 },
          { module_code: "AH-3304", mc: 4, marks: 65 },
          { module_code: "LY-1433", mc: 4, marks: 69.3 }
        ]
      },
      4: {
        gpa: 2.67,
        modules: [
          { module_code: "AH-2203", mc: 4, marks: 59.1 },
          { module_code: "AH-3305", mc: 4, marks: 65 },
          { module_code: "AH-4314", mc: 4, marks: 71.4 },
          { module_code: "PB-1303", mc: 4, marks: 76 },
          { module_code: "SC-1483", mc: 4, marks: 50.8 }
        ]
      },
      5: {
        gpa: 0,
        modules: [
          { module_code: "DW-3001", mc: 16, marks: 79.3 }
        ]
      },
      6: {
        gpa: 0,
        modules: [
          { module_code: "DC-3001", mc: 16, marks: 80 }
        ]
      },
      7: {
        gpa: 3.17,
        modules: [
          { module_code: "AH-4312", mc: 4, marks: 65 },
          { module_code: "AH-5301", mc: 4, marks: 74 },
          { module_code: "PB-2303", mc: 4, marks: 72.8 },
          { module_code: "AH-2307", mc: 4, marks: 65.3 },
          { module_code: "AH-4201", mc: 0, marks: 0 }
        ]
      }
    },

    "Low Risk": {
      1: {
        gpa: 3.7,
        modules: [
          { module_code: "PB-1201", mc: 4, marks: 77.8 },
          { module_code: "PB-1501", mc: 4, marks: 81.2 },
          { module_code: "LE-1503", mc: 4, marks: 70 },
          { module_code: "AW-2309", mc: 4, marks: 64 },
          { module_code: "AW-1201", mc: 4, marks: 70.7 }
        ]
      },
      2: {
        gpa: 3.9,
        modules: [
          { module_code: "AW-1304", mc: 4, marks: 70.5 },
          { module_code: "LE-2503", mc: 4, marks: 74 },
          { module_code: "AW-1202", mc: 4, marks: 73.3 },
          { module_code: "LK-1403", mc: 4, marks: 85 },
          { module_code: "AW-2301", mc: 4, marks: 72.5 }
        ]
      },
      3: {
        gpa: 3.8,
        modules: [
          { module_code: "AW-2201", mc: 4, marks: 62.9 },
          { module_code: "AW-3302", mc: 4, marks: 70.2 },
          { module_code: "LK-2403", mc: 4, marks: 82 },
          { module_code: "MS-1501", mc: 4, marks: 86 },
          { module_code: "SC-1483", mc: 4, marks: 78.4 }
        ]
      },
      4: {
        gpa: 3.92,
        modules: [
          { module_code: "AW-2304", mc: 4, marks: 66.3 },
          { module_code: "AW-2305", mc: 4, marks: 79.7 },
          { module_code: "AW-3307", mc: 8, marks: 89.5 },
          { module_code: "AW-4320", mc: 4, marks: 64 }
        ]
      },
      5: {
        gpa: 0,
        modules: [
          { module_code: "DW-3001", mc: 16, marks: 85 }
        ]
      },
      6: {
        gpa: 0,
        modules: [
          { module_code: "SS084300", mc: 4, marks: 0 },
          { module_code: "SS100800", mc: 4, marks: 0 },
          { module_code: "SS081800", mc: 4, marks: 0 },
          { module_code: "SS104800", mc: 4, marks: 0 }
        ]
      },
      7: {
        gpa: 4,
        modules: [
          { module_code: "AW-2314", mc: 4, marks: 75 },
          { module_code: "AW-4201", mc: 0, marks: 0 },
          { module_code: "AW-4304", mc: 4, marks: 76.5 },
          { module_code: "AW-4307", mc: 4, marks: 79 }
        ]
      }
    }
  };

  const sample = SAMPLE_PROFILES[profileName];

  for (let semNum = 1; semNum < x; semNum++) {
    document.getElementById(`gpa_${semNum}`).value = sample[semNum]?.gpa ?? "";
    const tbody = document.getElementById(`tbody_${semNum}`);
    tbody.innerHTML = "";
    (sample[semNum]?.modules || []).forEach((m) => addModuleRow(semNum, m));
  }

  const payload = collectRawInput();
  const features = computeAllFeaturesPreview(payload);
  renderFeaturePreview(features);
  buildSemesterOverview(payload, features);
  renderQuickOverview(features, x);
  renderGpaTrend(features, x);
  renderWavgTrend(features, x);
  renderWeakAreas(features, x);
}

predictSemesterXSelect.addEventListener("change", () => {
  updateScopeDisplay();
  createSemesterCards();
  resetStudentVisuals();
});

sampleHighBtn.addEventListener("click", () => {
  loadSampleDataForX(getPredictSemesterX(), "High Risk");
});

sampleModerateBtn.addEventListener("click", () => {
  loadSampleDataForX(getPredictSemesterX(), "Moderate Risk");
});

sampleLowBtn.addEventListener("click", () => {
  loadSampleDataForX(getPredictSemesterX(), "Low Risk");
});

clearBtn.addEventListener("click", () => {
  document.getElementById("studentId").value = "";
  document.getElementById("programme").value = "";
  predictSemesterXSelect.value = "5";
  updateScopeDisplay();
  createSemesterCards();
  resetStudentVisuals();
});

predictBtn.addEventListener("click", async () => {
  const payload = collectRawInput();
  const previewFeatures = computeAllFeaturesPreview(payload);

  renderFeaturePreview(previewFeatures);
  buildSemesterOverview(payload, previewFeatures);
  renderQuickOverview(previewFeatures, payload.predict_semester_x);
  renderGpaTrend(previewFeatures, payload.predict_semester_x);
  renderWavgTrend(previewFeatures, payload.predict_semester_x);
  renderWeakAreas(previewFeatures, payload.predict_semester_x);

  try {
    const response = await fetch("/predict", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(payload)
    });

    const result = await response.json();

    if (!response.ok) {
      alert(result.error || "Prediction failed.");
      return;
    }

    renderPrediction(result, payload);
  } catch (error) {
    console.error(error);
    alert("Could not connect to Flask backend. Make sure app.py is running.");
  }
});

/* =========================
   LECTURER VIEW
========================= */
const viewButtons = document.querySelectorAll(".view-btn");
const viewPanels = document.querySelectorAll(".view-panel");
const predictBatchBtn = document.getElementById("predictBatchBtn");
const clearBatchBtn = document.getElementById("clearBatchBtn");
const exportBatchBtn = document.getElementById("exportBatchBtn");
const lecturerFile = document.getElementById("lecturerFile");
const filterButtons = document.querySelectorAll(".filter-btn");
const batchLoadingState = document.getElementById("batchLoadingState");

viewButtons.forEach((btn) => {
  btn.addEventListener("click", () => {
    viewButtons.forEach((b) => b.classList.remove("active"));
    viewPanels.forEach((p) => p.classList.remove("active-view"));
    btn.classList.add("active");
    document.getElementById(btn.dataset.view).classList.add("active-view");
  });
});

filterButtons.forEach((btn) => {
  btn.addEventListener("click", () => {
    filterButtons.forEach((b) => b.classList.remove("active-filter"));
    btn.classList.add("active-filter");
    currentBatchFilter = btn.dataset.risk;
    renderBatchTable();
  });
});

predictBatchBtn.addEventListener("click", async () => {
  if (!lecturerFile.files.length) {
    alert("Please upload an Excel file first.");
    return;
  }

  const formData = new FormData();
  formData.append("file", lecturerFile.files[0]);

  batchLoadingState.classList.remove("hidden");
  predictBatchBtn.disabled = true;
  clearBatchBtn.disabled = true;
  exportBatchBtn.disabled = true;

  try {
    const response = await fetch("/predict_batch", {
      method: "POST",
      body: formData
    });

    const result = await response.json();

    if (!response.ok) {
      alert(result.error || "Batch prediction failed.");
      return;
    }

    renderBatchResults(result);

    document.getElementById("lecturerDashboardOutput").scrollIntoView({
      behavior: "smooth",
      block: "start"
    });
  } catch (error) {
    console.error(error);
    alert("Could not connect to Flask backend for batch prediction.");
  } finally {
    batchLoadingState.classList.add("hidden");
    predictBatchBtn.disabled = false;
    clearBatchBtn.disabled = false;
    exportBatchBtn.disabled = false;
  }
});

clearBatchBtn.addEventListener("click", () => {
  lecturerFile.value = "";
  batchResultsCache = [];
  currentBatchFilter = "All";

  document.getElementById("batchTotalStudents").textContent = "-";
  document.getElementById("batchHighRisk").textContent = "-";
  document.getElementById("batchModerateRisk").textContent = "-";
  document.getElementById("batchLowRisk").textContent = "-";
  document.getElementById("batchTotalPct").textContent = "-";
  document.getElementById("batchHighRiskPct").textContent = "-";
  document.getElementById("batchModerateRiskPct").textContent = "-";
  document.getElementById("batchLowRiskPct").textContent = "-";

  document.getElementById("majorMostHighRisk").textContent = "-";
  document.getElementById("sharpestDecline").textContent = "-";
  document.getElementById("weakestLevel").textContent = "-";
  document.getElementById("weakestType").textContent = "-";

  document.getElementById("batchTableBody").innerHTML =
    '<tr><td colspan="8" class="empty-note">No batch prediction yet.</td></tr>';

  destroyBatchCharts();
});

exportBatchBtn.addEventListener("click", () => {
  if (!batchResultsCache.length) {
    alert("No batch results to export.");
    return;
  }

  const headers = [
    "REGNO", "MAJOR", "GPA_Y1S1", "GPA_Y1S2", "GPA_Y2S1", "GPA_Y2S2",
    "Latest_WAVG_Mark", "Predicted_Risk"
  ];

  const rows = batchResultsCache.map((row) => [
    row.REGNO,
    row.MAJOR,
    row.GPA_Y1S1,
    row.GPA_Y1S2,
    row.GPA_Y2S1,
    row.GPA_Y2S2,
    row.Latest_WAVG_Mark,
    row.prediction
  ]);

  const csv = [headers, ...rows]
    .map((r) => r.map((v) => `"${String(v ?? "")}"`).join(","))
    .join("\n");

  const blob = new Blob([csv], { type: "text/csv;charset=utf-8;" });
  const url = URL.createObjectURL(blob);

  const a = document.createElement("a");
  a.href = url;
  a.download = "predicted_student_list.csv";
  document.body.appendChild(a);
  a.click();
  document.body.removeChild(a);
  URL.revokeObjectURL(url);
});

function getRiskBadgeHTML(risk) {
  let klass = "risk-low";
  if (risk === "High Risk") klass = "risk-high";
  else if (risk === "Moderate Risk") klass = "risk-moderate";
  return `<span class="risk-badge ${klass}">${risk}</span>`;
}

function renderBatchTable() {
  const body = document.getElementById("batchTableBody");

  let rows = batchResultsCache;
  if (currentBatchFilter !== "All") {
    rows = rows.filter((r) => r.prediction === currentBatchFilter);
  }

  if (!rows.length) {
    body.innerHTML = '<tr><td colspan="8" class="empty-note">No students in this category.</td></tr>';
    return;
  }

  body.innerHTML = rows.map((row) => `
    <tr>
      <td>${row.REGNO || "-"}</td>
      <td>${row.MAJOR || "-"}</td>
      <td>${Number(row.GPA_Y1S1 ?? 0).toFixed(2)}</td>
      <td>${Number(row.GPA_Y1S2 ?? 0).toFixed(2)}</td>
      <td>${Number(row.GPA_Y2S1 ?? 0).toFixed(2)}</td>
      <td>${Number(row.GPA_Y2S2 ?? 0).toFixed(2)}</td>
      <td>${Number(row.Latest_WAVG_Mark ?? 0).toFixed(2)}</td>
      <td>${getRiskBadgeHTML(row.prediction || "-")}</td>
    </tr>
  `).join("");
}

function destroyBatchCharts() {
  [batchRiskDistributionChart, batchRiskBySemesterChart, batchGpaByMajorChart, batchWavgTrendChart]
    .forEach((chart) => {
      if (chart) chart.destroy();
    });

  batchRiskDistributionChart = null;
  batchRiskBySemesterChart = null;
  batchGpaByMajorChart = null;
  batchWavgTrendChart = null;
}

function renderBatchCharts(result) {
  destroyBatchCharts();

  const distCtx = document.getElementById("batchRiskDistributionChart");
  batchRiskDistributionChart = new Chart(distCtx, {
    type: "doughnut",
    data: {
      labels: ["High Risk", "Moderate Risk", "Low Risk"],
      datasets: [{
        data: [
          result.summary["High Risk"] || 0,
          result.summary["Moderate Risk"] || 0,
          result.summary["Low Risk"] || 0
        ],
        backgroundColor: ["#e46060", "#e5a53a", "#2fa56f"]
      }]
    },
    options: { responsive: true, maintainAspectRatio: false }
  });

  const riskSemester = result.risk_count_by_semester || {};
  const riskSemCtx = document.getElementById("batchRiskBySemesterChart");
  batchRiskBySemesterChart = new Chart(riskSemCtx, {
    type: "bar",
    data: {
      labels: ["Y1S1", "Y1S2", "Y2S1", "Y2S2"],
      datasets: [
        {
          label: "High Risk",
          data: ["Y1S1", "Y1S2", "Y2S1", "Y2S2"].map((s) => riskSemester[s]?.["High Risk"] || 0),
          backgroundColor: "#e46060"
        },
        {
          label: "Moderate Risk",
          data: ["Y1S1", "Y1S2", "Y2S1", "Y2S2"].map((s) => riskSemester[s]?.["Moderate Risk"] || 0),
          backgroundColor: "#e5a53a"
        },
        {
          label: "Low Risk",
          data: ["Y1S1", "Y1S2", "Y2S1", "Y2S2"].map((s) => riskSemester[s]?.["Low Risk"] || 0),
          backgroundColor: "#2fa56f"
        }
      ]
    },
    options: {
      responsive: true,
      maintainAspectRatio: false,
      scales: { x: { stacked: true }, y: { stacked: true, beginAtZero: true } }
    }
  });

  const gpaMajor = result.gpa_trend_by_major || {};
  const gpaMajorCtx = document.getElementById("batchGpaByMajorChart");
  batchGpaByMajorChart = new Chart(gpaMajorCtx, {
    type: "line",
    data: {
      labels: ["Y1S1", "Y1S2", "Y2S1", "Y2S2"],
      datasets: Object.entries(gpaMajor).map(([major, vals]) => ({
        label: major,
        data: ["Y1S1", "Y1S2", "Y2S1", "Y2S2"].map((s) => vals[s] || 0),
        tension: 0.35,
        fill: false
      }))
    },
    options: {
      responsive: true,
      maintainAspectRatio: false,
      scales: { y: { beginAtZero: true, max: 4 } }
    }
  });

  const wavgTrend = result.wavg_trend_by_semester || {};
  const wavgCtx = document.getElementById("batchWavgTrendChart");
  batchWavgTrendChart = new Chart(wavgCtx, {
    type: "line",
    data: {
      labels: ["Y1S1", "Y1S2", "Y2S1", "Y2S2"],
      datasets: [{
        label: "Average Weighted Mark",
        data: ["Y1S1", "Y1S2", "Y2S1", "Y2S2"].map((s) => wavgTrend[s] || 0),
        borderColor: "#4f7cff",
        backgroundColor: "rgba(79, 124, 255, 0.12)",
        fill: true,
        tension: 0.35
      }]
    },
    options: { responsive: true, maintainAspectRatio: false }
  });
}

function renderBatchResults(result) {
  batchResultsCache = result.results || [];

  document.getElementById("batchTotalStudents").textContent = result.total_students || 0;
  document.getElementById("batchHighRisk").textContent = result.summary["High Risk"] || 0;
  document.getElementById("batchModerateRisk").textContent = result.summary["Moderate Risk"] || 0;
  document.getElementById("batchLowRisk").textContent = result.summary["Low Risk"] || 0;

  document.getElementById("batchTotalPct").textContent = "100%";
  document.getElementById("batchHighRiskPct").textContent = `${result.percentages["High Risk"] || 0}%`;
  document.getElementById("batchModerateRiskPct").textContent = `${result.percentages["Moderate Risk"] || 0}%`;
  document.getElementById("batchLowRiskPct").textContent = `${result.percentages["Low Risk"] || 0}%`;

  document.getElementById("majorMostHighRisk").textContent = result.derived.major_most_high_risk || "-";
  document.getElementById("sharpestDecline").textContent = result.derived.semester_sharpest_decline || "-";
  document.getElementById("weakestLevel").textContent = result.derived.weakest_module_level || "-";
  document.getElementById("weakestType").textContent = result.derived.weakest_module_type || "-";

  renderBatchTable();
  renderBatchCharts(result);
}

updateScopeDisplay();
createSemesterCards();