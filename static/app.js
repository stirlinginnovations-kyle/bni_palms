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

const selectedStore = {
  weekly: null,
  ytd: null,
  traffic: null,
};

const typeLabels = {
  weekly: "Weekly Report (.xls/.xlsx)",
  ytd: "YTD Report (.xls/.xlsx)",
  traffic: "Traffic Lights (.pdf)",
};

const typeSummaryLabels = {
  weekly: "Weekly",
  ytd: "YTD",
  traffic: "Traffic Lights",
};

const defaultLoadButtonLabel = loadButton ? loadButton.textContent : "";
let isUploading = false;

function setStatus(message, tone = "muted") {
  statusEl.textContent = message;
  statusEl.style.color = tone === "error" ? "#b23c17" : "";
}

function setEmptySummaryState() {
  if (!uploadList || uploadList.children.length > 0) return;
  const item = document.createElement("li");
  item.className = "summary-empty";
  item.textContent = "No files loaded yet.";
  uploadList.appendChild(item);
}

function clearEmptySummaryState() {
  const empty = uploadList.querySelector(".summary-empty");
  if (empty) empty.remove();
}

function redirectToLogin() {
  const next = encodeURIComponent(window.location.pathname);
  window.location.assign(`/login?next=${next}`);
}

function setUploadState(uploading, type = "") {
  isUploading = uploading;
  if (!loadButton) return;
  loadButton.disabled = uploading;
  loadButton.classList.toggle("is-loading", uploading);
  if (uploading) {
    loadButton.textContent =
      type === "traffic" ? "Loading Traffic Lights..." : "Loading Report...";
    return;
  }
  loadButton.textContent =
    defaultLoadButtonLabel || "Load Selected Report To Analytics";
}

function getChapterValue() {
  const custom = chapterCustom.value.trim();
  if (custom) return custom;
  return chapterSelect.value.trim();
}

async function loadChapters() {
  try {
    const res = await fetch("/api/chapters");
    if (res.status === 401) {
      redirectToLogin();
      return;
    }
    const payload = await res.json().catch(() => ({}));
    if (!res.ok) {
      throw new Error(payload.detail || "Unable to load chapters.");
    }
    if (!Array.isArray(payload)) {
      throw new Error("Chapters response was not a list.");
    }
    chapterSelect.innerHTML = "";
    if (payload.length === 0) {
      const opt = document.createElement("option");
      opt.value = "";
      opt.textContent = "No chapters loaded";
      chapterSelect.appendChild(opt);
      return;
    }
    payload.forEach((chapter) => {
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
  return typeLabels[type] || typeLabels.traffic;
}

function getTypeSummaryLabel(type) {
  return typeSummaryLabels[type] || typeSummaryLabels.traffic;
}

function updateDropMeta() {
  const type = reportType.value;
  dropTitle.textContent = getTypeLabel(type);
  const selected = selectedStore[type];
  dropFile.textContent = selected ? `Selected: ${selected.name}` : "No file selected";
  fileInput.accept = type === "traffic" ? ".pdf" : ".xls,.xlsx";
}

function addUploadLog(type, fileName, chapter) {
  clearEmptySummaryState();
  const timestamp = new Date().toLocaleString();
  const item = document.createElement("li");
  item.className = "summary-item";
  item.textContent = `${getTypeSummaryLabel(type)} • ${chapter} • ${fileName} • ${timestamp}`;
  uploadList.prepend(item);
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
    `${getTypeLabel(type)} selected. Click "Load Selected Report To Analytics" and enter the chapter PIN.`,
  );
}

async function uploadFile(type, file, chapterPin) {
  if (isUploading) return;

  const chapter = getChapterValue();
  if (!chapter) {
    setStatus("Select or type a chapter name before uploading.", "error");
    return;
  }
  if (!chapterPin) {
    setStatus("Chapter PIN is required to upload.", "error");
    return;
  }
  if (!file) return;
  if (!validateSelectedFile(type, file)) return;

  const formData = new FormData();
  formData.append("chapter", chapter);
  formData.append("report_type", type);
  formData.append("chapter_pin", chapterPin);
  formData.append("file", file);

  setStatus(
    type === "traffic"
      ? "Loading traffic lights report to analytics. This can take up to a minute..."
      : "Loading report to analytics...",
  );
  setUploadState(true, type);

  try {
    const res = await fetch("/api/upload", {
      method: "POST",
      body: formData,
    });
    if (res.status === 401) {
      redirectToLogin();
      return;
    }
    const payload = await res.json().catch(() => ({}));
    if (!res.ok) {
      throw new Error(payload.detail || "Upload failed");
    }

    selectedStore[type] = null;
    updateDropMeta();
    addUploadLog(type, file.name, chapter);
    setStatus(`${getTypeSummaryLabel(type)} loaded to analytics.`);
  } catch (err) {
    setStatus(err.message || "Upload failed.", "error");
  } finally {
    setUploadState(false);
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
    selectFile(reportType.value, event.dataTransfer.files[0]);
  });
  fileInput.addEventListener("change", () => {
    if (!fileInput.files.length) return;
    selectFile(reportType.value, fileInput.files[0]);
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

    const chapter = getChapterValue();
    if (!chapter) {
      setStatus("Select or type a chapter name before uploading.", "error");
      return;
    }

    const chapterPin = window.prompt(`Enter upload PIN for "${chapter}":`);
    if (chapterPin === null) {
      setStatus("Upload canceled. PIN entry is required.");
      return;
    }
    if (!chapterPin.trim()) {
      setStatus("Chapter PIN is required to upload.", "error");
      return;
    }

    uploadFile(type, file, chapterPin.trim());
  });
}

loadChapters();
updateDropMeta();
attachDropZone();
setEmptySummaryState();
