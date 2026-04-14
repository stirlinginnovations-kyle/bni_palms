const chapterSelect = document.getElementById("chapterSelect");
const chapterCustom = document.getElementById("chapterCustom");
const reportType = document.getElementById("reportType");
const fileInput = document.getElementById("fileInput");
const dropTitle = document.getElementById("dropTitle");
const dropFile = document.getElementById("dropFile");
const fileDrop = document.getElementById("fileDrop");
const statusEl = document.getElementById("status");
const loadButton = document.getElementById("loadButton");
const uploadList = document.getElementById("uploadList");
const validationEls = {
  weekly: document.getElementById("weeklyValidation"),
  ytd: document.getElementById("ytdValidation"),
  traffic: document.getElementById("trafficValidation"),
};

const fileLabels = {
  weekly: document.getElementById("weeklyName"),
  ytd: document.getElementById("ytdName"),
  traffic: document.getElementById("trafficName"),
};

const selectedStore = {
  weekly: null,
  ytd: null,
  traffic: null,
};

const fileStore = {
  weekly: null,
  ytd: null,
  traffic: null,
};

const validationStore = {
  weekly: null,
  ytd: null,
  traffic: null,
};

function setStatus(message, tone = "muted") {
  statusEl.textContent = message;
  statusEl.style.color = tone === "error" ? "#b23c17" : "";
}

function updateFileLabel(type) {
  const label = fileLabels[type];
  if (!label) return;
  label.textContent = fileStore[type] ? fileStore[type].name : "Not uploaded";
}

function getChapterValue() {
  const custom = chapterCustom.value.trim();
  if (custom) return custom;
  return chapterSelect.value.trim();
}

async function loadChapters() {
  try {
    const res = await fetch("/api/chapters");
    const chapters = await res.json();
    chapterSelect.innerHTML = "";
    if (chapters.length === 0) {
      const opt = document.createElement("option");
      opt.value = "";
      opt.textContent = "No chapters loaded";
      chapterSelect.appendChild(opt);
      return;
    }
    chapters.forEach((chapter) => {
      const opt = document.createElement("option");
      opt.value = chapter;
      opt.textContent = chapter;
      chapterSelect.appendChild(opt);
    });
  } catch (err) {
    setStatus("Unable to load chapters.", "error");
  }
}

function getTypeLabel(type) {
  if (type === "weekly") return "Weekly Report (.xls/.xlsx)";
  if (type === "ytd") return "YTD Report (.xls/.xlsx)";
  return "Traffic Lights (.pdf)";
}

function updateDropMeta() {
  const type = reportType.value;
  dropTitle.textContent = getTypeLabel(type);
  const selected = selectedStore[type];
  dropFile.textContent = selected ? `Selected: ${selected.name}` : "No file selected";
  fileInput.accept = type === "traffic" ? ".pdf" : ".xls,.xlsx";
}

function addUploadLog(type, fileName) {
  const timestamp = new Date().toLocaleString();
  const item = document.createElement("li");
  item.textContent = `${timestamp} • ${getTypeLabel(type)} • ${fileName}`;
  uploadList.prepend(item);
}

function appendValidationRow(container, label, value) {
  const row = document.createElement("div");
  row.className = "validation-row";

  const labelEl = document.createElement("div");
  labelEl.className = "validation-label";
  labelEl.textContent = label;

  const valueEl = document.createElement("div");
  valueEl.className = "validation-value";
  valueEl.textContent = value ?? "N/A";

  row.appendChild(labelEl);
  row.appendChild(valueEl);
  container.appendChild(row);
}

function appendValidationList(container, label, values) {
  if (!Array.isArray(values) || values.length === 0) return;

  const row = document.createElement("div");
  row.className = "validation-row";

  const labelEl = document.createElement("div");
  labelEl.className = "validation-label";
  labelEl.textContent = label;

  const list = document.createElement("ul");
  list.className = "validation-list";
  values.forEach((value) => {
    const item = document.createElement("li");
    item.textContent = String(value);
    list.appendChild(item);
  });

  row.appendChild(labelEl);
  row.appendChild(list);
  container.appendChild(row);
}

function formatReferralTally(validation) {
  const tally = validation?.referral_tally;
  if (!tally || typeof tally !== "object") return "";
  const columns = Array.isArray(validation?.referral_columns)
    ? validation.referral_columns
    : Object.keys(tally);
  return columns
    .filter((col) => col in tally)
    .map((col) => `${col} ${tally[col] ?? 0}`)
    .join(", ");
}

function renderValidation(type) {
  const container = validationEls[type];
  if (!container) return;

  container.innerHTML = "";
  const state = validationStore[type];
  if (!state) {
    const empty = document.createElement("div");
    empty.className = "validation-empty";
    empty.textContent = "No report loaded yet.";
    container.appendChild(empty);
    return;
  }

  appendValidationRow(container, "File", state.fileName);
  appendValidationRow(container, "Chapter", state.chapter);
  appendValidationRow(container, "Uploaded", state.uploadedAt);

  const validation = state.validation;
  if (!validation) {
    appendValidationRow(container, "Validation", "No parsed details returned.");
    return;
  }

  appendValidationRow(container, "Rows Parsed", String(validation.rows_parsed ?? 0));

  if (validation.table_start_row !== undefined) {
    appendValidationRow(
      container,
      "Table Starts",
      `Row ${String(validation.table_start_row)}`,
    );
  }

  if (validation.referral_tally) {
    const tallyText = formatReferralTally(validation);
    appendValidationRow(
      container,
      "Referral Tally",
      tallyText || "N/A",
    );
  }

  if (validation.referrals_total !== undefined) {
    appendValidationRow(
      container,
      "Referrals Total",
      String(validation.referrals_total),
    );
  }

  if (
    Array.isArray(validation.key_metrics_summary) &&
    validation.key_metrics_summary.length
  ) {
    validation.key_metrics_summary.forEach((metric) => {
      appendValidationRow(
        container,
        String(metric.label || "Metric"),
        String(metric.value ?? 0),
      );
    });
  }

  if (validation.chapters_detected_count !== undefined) {
    appendValidationRow(
      container,
      "Chapters Detected",
      String(validation.chapters_detected_count),
    );
  }

  if (validation.score_average !== undefined) {
    appendValidationRow(container, "Score Avg", String(validation.score_average));
  }

  if (validation.score_max !== undefined) {
    appendValidationRow(container, "Score Max", String(validation.score_max));
  }

  appendValidationList(container, "Sample Members", validation.sample_members || []);
  appendValidationList(
    container,
    `Columns Loaded (${(validation.columns_loaded || []).length})`,
    validation.columns_loaded || [],
  );
  appendValidationList(
    container,
    "Detected Chapters",
    validation.chapters_detected || [],
  );
}

function getValidationStatusMessage(type, validation) {
  if (!validation) return "Upload complete.";

  const parts = [
    `Loaded to analytics. Rows parsed: ${validation.rows_parsed ?? 0}.`,
  ];
  if (validation.referrals_total !== undefined) {
    parts.push(`Referrals total: ${validation.referrals_total}.`);
  }
  if ((type === "weekly" || type === "ytd") && validation.referral_tally) {
    const tallyText = formatReferralTally(validation);
    if (tallyText) parts.push(`${tallyText}.`);
  }
  if (type === "traffic" && validation.chapters_detected_count !== undefined) {
    parts.push(`Chapters detected: ${validation.chapters_detected_count}.`);
  }
  if (type === "traffic" && validation.score_average !== undefined) {
    parts.push(`Score avg: ${validation.score_average}.`);
  }
  if (type === "traffic" && validation.score_max !== undefined) {
    parts.push(`Score max: ${validation.score_max}.`);
  }
  return parts.join(" ");
}

function validateSelectedFile(type, file) {
  if (!file) return false;
  const lowerName = file.name.toLowerCase();
  const isPdf = lowerName.endsWith(".pdf");
  const isExcel = lowerName.endsWith(".xls") || lowerName.endsWith(".xlsx");
  if (type === "traffic" && !isPdf) {
    setStatus("Traffic Lights must be a .pdf file.", "error");
    return false;
  }
  if ((type === "weekly" || type === "ytd") && !isExcel) {
    setStatus("Weekly and YTD reports must be .xls or .xlsx files.", "error");
    return false;
  }
  return true;
}

function selectFile(type, file) {
  if (!validateSelectedFile(type, file)) return;
  selectedStore[type] = file;
  updateDropMeta();
  setStatus(
    `${getTypeLabel(type)} selected. Click "Load Selected Report To Analytics" to upload.`,
  );
}

async function uploadFile(type, file) {
  const chapter = getChapterValue();
  if (!chapter) {
    setStatus("Select or type a chapter name before uploading.", "error");
    return;
  }
  if (!file) return;

  if (!validateSelectedFile(type, file)) {
    return;
  }

  const formData = new FormData();
  formData.append("chapter", chapter);
  formData.append("report_type", type);
  formData.append("file", file);

  setStatus("Loading report to analytics...");

  try {
    const res = await fetch("/api/upload", {
      method: "POST",
      body: formData,
    });
    const payload = await res.json().catch(() => ({}));
    if (!res.ok) {
      throw new Error(payload.detail || "Upload failed");
    }

    fileStore[type] = file;
    selectedStore[type] = null;
    updateFileLabel(type);
    updateDropMeta();
    addUploadLog(type, file.name);

    validationStore[type] = {
      fileName: file.name,
      chapter,
      uploadedAt: new Date().toLocaleString(),
      validation: payload.validation || null,
    };
    renderValidation(type);
    setStatus(getValidationStatusMessage(type, payload.validation || null));
  } catch (err) {
    setStatus(err.message || "Upload failed.", "error");
  }
}

function attachDropZone() {
  fileDrop.addEventListener("dragover", (event) => {
    event.preventDefault();
    fileDrop.classList.add("dragging");
  });
  fileDrop.addEventListener("dragleave", () => {
    fileDrop.classList.remove("dragging");
  });
  fileDrop.addEventListener("drop", (event) => {
    event.preventDefault();
    fileDrop.classList.remove("dragging");
    if (!event.dataTransfer.files.length) return;
    const file = event.dataTransfer.files[0];
    const type = reportType.value;
    selectFile(type, file);
  });
  fileInput.addEventListener("change", () => {
    if (!fileInput.files.length) return;
    const type = reportType.value;
    selectFile(type, fileInput.files[0]);
    fileInput.value = "";
  });
  reportType.addEventListener("change", updateDropMeta);
  loadButton.addEventListener("click", () => {
    const type = reportType.value;
    const file = selectedStore[type];
    if (!file) {
      setStatus(`Select a ${getTypeLabel(type)} file first.`, "error");
      return;
    }
    uploadFile(type, file);
  });
}

loadChapters();
updateDropMeta();
attachDropZone();
renderValidation("weekly");
renderValidation("ytd");
renderValidation("traffic");
