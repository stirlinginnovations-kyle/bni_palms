const chapterSelect = document.getElementById("chapterSelect");
const chapterCustom = document.getElementById("chapterCustom");
const reportType = document.getElementById("reportType");
const fileInput = document.getElementById("fileInput");
const dropTitle = document.getElementById("dropTitle");
const dropFile = document.getElementById("dropFile");
const fileDrop = document.getElementById("fileDrop");
const statusEl = document.getElementById("status");
const uploadList = document.getElementById("uploadList");

const fileLabels = {
  weekly: document.getElementById("weeklyName"),
  ytd: document.getElementById("ytdName"),
  traffic: document.getElementById("trafficName"),
};

const fileStore = {
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
  if (type === "weekly") return "Weekly Report (.xls)";
  if (type === "ytd") return "YTD Report (.xls)";
  return "Traffic Lights (.pdf)";
}

function updateDropMeta() {
  const type = reportType.value;
  dropTitle.textContent = getTypeLabel(type);
  dropFile.textContent = "No file selected";
  fileInput.accept = type === "traffic" ? ".pdf" : ".xls";
}

function addUploadLog(type, fileName) {
  const timestamp = new Date().toLocaleString();
  const item = document.createElement("li");
  item.textContent = `${timestamp} • ${getTypeLabel(type)} • ${fileName}`;
  uploadList.prepend(item);
}

async function uploadFile(type, file) {
  const chapter = getChapterValue();
  if (!chapter) {
    setStatus("Select or type a chapter name before uploading.", "error");
    return;
  }
  if (!file) return;

  const isPdf = file.name.toLowerCase().endsWith(".pdf");
  const isXls = file.name.toLowerCase().endsWith(".xls");
  if (type === "traffic" && !isPdf) {
    setStatus("Traffic Lights must be a .pdf file.", "error");
    return;
  }
  if ((type === "weekly" || type === "ytd") && !isXls) {
    setStatus("Weekly and YTD reports must be .xls files.", "error");
    return;
  }

  const formData = new FormData();
  formData.append("chapter", chapter);
  formData.append("report_type", type);
  formData.append("file", file);

  setStatus("Uploading...");

  try {
    const res = await fetch("/api/upload", {
      method: "POST",
      body: formData,
    });
    if (!res.ok) {
      const detail = await res.json();
      throw new Error(detail.detail || "Upload failed");
    }

    fileStore[type] = file;
    updateFileLabel(type);
    dropFile.textContent = file.name;
    addUploadLog(type, file.name);
    setStatus("Upload complete.");
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
    uploadFile(type, file);
  });
  fileInput.addEventListener("change", () => {
    if (!fileInput.files.length) return;
    const type = reportType.value;
    uploadFile(type, fileInput.files[0]);
    fileInput.value = "";
  });
  reportType.addEventListener("change", updateDropMeta);
}

loadChapters();
updateDropMeta();
attachDropZone();
