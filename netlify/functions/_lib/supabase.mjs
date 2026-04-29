export class SupabaseError extends Error {
  constructor(message) {
    super(message);
    this.name = "SupabaseError";
  }
}

function supabaseConfigFromEnv() {
  const url = (process.env.SUPABASE_URL || "").trim();
  const serviceKey =
    (process.env.SUPABASE_SERVICE_ROLE_KEY || "").trim() ||
    (process.env.SUPABASE_SERVICE_KEY || "").trim() ||
    (process.env.SUPABASE_SECRET_KEY || "").trim();
  const bucket = (process.env.SUPABASE_STORAGE_BUCKET || "chapter-reports").trim();
  if (!url || !serviceKey) {
    return null;
  }
  return { url, serviceKey, bucket };
}

function buildQueryString(query) {
  if (!query) {
    return "";
  }
  const params = new URLSearchParams();
  for (const [key, value] of Object.entries(query)) {
    if (value === undefined || value === null) {
      continue;
    }
    params.set(key, String(value));
  }
  const qs = params.toString();
  return qs ? `?${qs}` : "";
}

export class SupabaseClient {
  constructor(config) {
    this.config = config;
    this.baseUrl = config.url.replace(/\/+$/, "");
  }

  static fromEnv() {
    const config = supabaseConfigFromEnv();
    if (!config) {
      return null;
    }
    return new SupabaseClient(config);
  }

  async request(
    method,
    path,
    {
      query = null,
      jsonBody = undefined,
      rawBody = undefined,
      contentType = undefined,
      prefer = undefined,
      extraHeaders = undefined,
    } = {},
  ) {
    if (jsonBody !== undefined && rawBody !== undefined) {
      throw new SupabaseError("Cannot send jsonBody and rawBody at the same time.");
    }

    const url = `${this.baseUrl}${path}${buildQueryString(query)}`;
    const headers = {
      apikey: this.config.serviceKey,
      authorization: `Bearer ${this.config.serviceKey}`,
    };
    if (prefer) {
      headers.prefer = prefer;
    }
    if (extraHeaders && typeof extraHeaders === "object") {
      Object.assign(headers, extraHeaders);
    }

    let body = undefined;
    if (jsonBody !== undefined) {
      body = JSON.stringify(jsonBody);
      headers["content-type"] = "application/json";
    } else if (rawBody !== undefined) {
      body = rawBody;
      if (contentType) {
        headers["content-type"] = contentType;
      }
    } else if (contentType) {
      headers["content-type"] = contentType;
    }

    let response;
    try {
      response = await fetch(url, {
        method: method.toUpperCase(),
        headers,
        body,
      });
    } catch (error) {
      throw new SupabaseError(`${method.toUpperCase()} ${path} failed: ${error}`);
    }

    const text = await response.text();
    if (!response.ok) {
      let detail = text.trim();
      try {
        const parsed = text ? JSON.parse(text) : null;
        if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) {
          detail = String(parsed.message || parsed.error || JSON.stringify(parsed));
        } else if (parsed !== null && parsed !== undefined) {
          detail = String(parsed);
        }
      } catch {
        // Keep raw text detail.
      }
      throw new SupabaseError(
        `${method.toUpperCase()} ${path} failed with ${response.status}: ${detail}`,
      );
    }

    if (!text) {
      return null;
    }
    const contentTypeHeader = response.headers.get("content-type") || "";
    if (contentTypeHeader.includes("application/json")) {
      try {
        return JSON.parse(text);
      } catch {
        return null;
      }
    }
    return text;
  }

  async listActiveChapters() {
    const rows = await this.request("GET", "/rest/v1/chapters", {
      query: {
        select: "name",
        is_active: "eq.true",
        order: "name.asc",
      },
    });
    if (!Array.isArray(rows)) {
      return [];
    }
    return rows
      .map((row) => String(row?.name || "").trim())
      .filter((name) => Boolean(name));
  }

  async getChapterUploadPin({ chapterSlug }) {
    const rows = await this.request("GET", "/rest/v1/chapter_upload_pins", {
      query: {
        select: "chapter_pin",
        chapter_slug: `eq.${chapterSlug}`,
        limit: "1",
      },
    });
    if (Array.isArray(rows) && rows.length > 0) {
      const pin = String(rows[0]?.chapter_pin || "").trim();
      return pin || null;
    }
    return null;
  }

  async upsertChapterUploadPin({ chapterSlug, chapterName, chapterPin }) {
    const rows = await this.request("POST", "/rest/v1/chapter_upload_pins", {
      query: {
        on_conflict: "chapter_slug",
        select: "chapter_slug,chapter_name,chapter_pin,updated_at",
      },
      jsonBody: [
        {
          chapter_slug: chapterSlug,
          chapter_name: chapterName,
          chapter_pin: chapterPin,
        },
      ],
      prefer: "resolution=merge-duplicates,return=representation",
    });
    if (Array.isArray(rows) && rows.length > 0) {
      return { ...rows[0] };
    }
    throw new SupabaseError("Failed to upsert chapter_upload_pins row.");
  }

  async getChapterYearlyGoals({ chapterSlug }) {
    const rows = await this.request("GET", "/rest/v1/chapter_yearly_goals", {
      query: {
        select: "chapter_slug,chapter_name,visitors,one_to_ones,referrals,ceu,tyfcb",
        chapter_slug: `eq.${chapterSlug}`,
        limit: "1",
      },
    });
    if (Array.isArray(rows) && rows.length > 0) {
      return { ...rows[0] };
    }
    return null;
  }

  async upsertChapterYearlyGoals({
    chapterSlug,
    chapterName,
    visitors,
    oneToOnes,
    referrals,
    ceu,
    tyfcb,
  }) {
    const rows = await this.request("POST", "/rest/v1/chapter_yearly_goals", {
      query: {
        on_conflict: "chapter_slug",
        select: "chapter_slug,chapter_name,visitors,one_to_ones,referrals,ceu,tyfcb,updated_at",
      },
      jsonBody: [
        {
          chapter_slug: chapterSlug,
          chapter_name: chapterName,
          visitors,
          one_to_ones: oneToOnes,
          referrals,
          ceu,
          tyfcb,
        },
      ],
      prefer: "resolution=merge-duplicates,return=representation",
    });
    if (Array.isArray(rows) && rows.length > 0) {
      return { ...rows[0] };
    }
    throw new SupabaseError("Failed to upsert chapter_yearly_goals row.");
  }

  async getChapterBySlug(slug) {
    const rows = await this.request("GET", "/rest/v1/chapters", {
      query: {
        select: "id,name,slug",
        slug: `eq.${slug}`,
        limit: "1",
      },
    });
    if (Array.isArray(rows) && rows.length > 0) {
      return { ...rows[0] };
    }
    return null;
  }

  async getLatestChapterUpload({ chapterId, reportType }) {
    const rows = await this.request("GET", "/rest/v1/chapter_report_uploads", {
      query: {
        select: "id,chapter_id,report_type,storage_path,uploaded_at",
        chapter_id: `eq.${chapterId}`,
        report_type: `eq.${reportType}`,
        order: "uploaded_at.desc,id.desc",
        limit: "1",
      },
    });
    if (Array.isArray(rows) && rows.length > 0) {
      return { ...rows[0] };
    }
    return null;
  }

  async getChapterMemberRowsForUpload(uploadId) {
    const rows = await this.request("GET", "/rest/v1/chapter_report_member_rows", {
      query: {
        select:
          "first_name,last_name,member_key,p,a,l,m,s,rgi,rgo,rri,rro,v,one_to_one,tyfcb,ceu,referrals_total",
        upload_id: `eq.${uploadId}`,
        order: "last_name.asc,first_name.asc",
      },
    });
    return Array.isArray(rows) ? rows.map((row) => ({ ...row })) : [];
  }

  async getLatestTrafficUpload() {
    const rows = await this.request("GET", "/rest/v1/traffic_light_uploads", {
      query: {
        select: "id,report_month,storage_path,uploaded_at",
        order: "report_month.desc,uploaded_at.desc,id.desc",
        limit: "1",
      },
    });
    if (Array.isArray(rows) && rows.length > 0) {
      return { ...rows[0] };
    }
    return null;
  }

  async getLatestNonemptyTrafficUpload() {
    const memberRows = await this.request("GET", "/rest/v1/traffic_light_member_rows", {
      query: {
        select: "traffic_upload_id,report_month",
        order: "report_month.desc,traffic_upload_id.desc",
        limit: "1",
      },
    });
    if (!Array.isArray(memberRows) || memberRows.length === 0) {
      return null;
    }

    const trafficUploadId = memberRows[0]?.traffic_upload_id;
    if (trafficUploadId === undefined || trafficUploadId === null) {
      return null;
    }

    const rows = await this.request("GET", "/rest/v1/traffic_light_uploads", {
      query: {
        select: "id,report_month,storage_path,uploaded_at",
        id: `eq.${trafficUploadId}`,
        limit: "1",
      },
    });
    if (Array.isArray(rows) && rows.length > 0) {
      return { ...rows[0] };
    }
    return null;
  }

  async getTrafficRowsForUpload({ trafficUploadId, chapterSlug }) {
    const rows = await this.request("GET", "/rest/v1/traffic_light_member_rows", {
      query: {
        select: "first_name,last_name,member_key,referrals,raw",
        traffic_upload_id: `eq.${trafficUploadId}`,
        chapter_slug: `eq.${chapterSlug}`,
        order: "last_name.asc,first_name.asc",
      },
    });
    return Array.isArray(rows) ? rows.map((row) => ({ ...row })) : [];
  }

  async upsertChapter({ name, slug }) {
    const rows = await this.request("POST", "/rest/v1/chapters", {
      query: {
        on_conflict: "slug",
        select: "id,name,slug",
      },
      jsonBody: [{ name, slug, is_active: true }],
      prefer: "resolution=merge-duplicates,return=representation",
    });
    if (Array.isArray(rows) && rows.length > 0) {
      return { ...rows[0] };
    }
    throw new SupabaseError("Failed to upsert chapter row.");
  }

  async listChapterReportUploads({ chapterId, reportType }) {
    const rows = await this.request("GET", "/rest/v1/chapter_report_uploads", {
      query: {
        select: "id,storage_path",
        chapter_id: `eq.${chapterId}`,
        report_type: `eq.${reportType}`,
        order: "uploaded_at.desc,id.desc",
      },
    });
    return Array.isArray(rows) ? rows.map((row) => ({ ...row })) : [];
  }

  async insertChapterReportUpload(payload) {
    const rows = await this.request("POST", "/rest/v1/chapter_report_uploads", {
      query: {
        select: "id,chapter_id,report_type,storage_path,uploaded_at",
      },
      jsonBody: [payload],
      prefer: "return=representation",
    });
    if (Array.isArray(rows) && rows.length > 0) {
      return { ...rows[0] };
    }
    throw new SupabaseError("Failed to insert chapter_report_uploads row.");
  }

  async deleteChapterReportUploadsExcept({ chapterId, reportType, keepUploadId }) {
    await this.request("DELETE", "/rest/v1/chapter_report_uploads", {
      query: {
        chapter_id: `eq.${chapterId}`,
        report_type: `eq.${reportType}`,
        id: `neq.${keepUploadId}`,
      },
      prefer: "return=minimal",
    });
  }

  async upsertTrafficLightUpload(payload) {
    const rows = await this.request("POST", "/rest/v1/traffic_light_uploads", {
      query: {
        on_conflict: "report_month",
        select: "id,report_month,storage_path",
      },
      jsonBody: [payload],
      prefer: "resolution=merge-duplicates,return=representation",
    });
    if (Array.isArray(rows) && rows.length > 0) {
      return { ...rows[0] };
    }
    throw new SupabaseError("Failed to upsert traffic_light_uploads row.");
  }

  async deleteTrafficLightMemberRows(trafficUploadId) {
    await this.request("DELETE", "/rest/v1/traffic_light_member_rows", {
      query: { traffic_upload_id: `eq.${trafficUploadId}` },
      prefer: "return=minimal",
    });
  }

  async insertChapterReportMemberRows(rows) {
    return this.insertRows("chapter_report_member_rows", rows);
  }

  async insertTrafficLightMemberRows(rows) {
    return this.insertRows("traffic_light_member_rows", rows);
  }

  async insertRows(table, rows) {
    if (!Array.isArray(rows) || rows.length === 0) {
      return 0;
    }
    const batchSize = 500;
    let inserted = 0;
    for (let index = 0; index < rows.length; index += batchSize) {
      const batch = rows.slice(index, index + batchSize);
      await this.request("POST", `/rest/v1/${table}`, {
        jsonBody: batch,
        prefer: "return=minimal",
      });
      inserted += batch.length;
    }
    return inserted;
  }

  async uploadObject({ objectPath, content, contentType, upsert = false }) {
    const normalizedPath = String(objectPath || "").trim().replace(/^\/+/, "");
    if (!normalizedPath) {
      throw new SupabaseError("Storage object path cannot be blank.");
    }
    const encodedPath = normalizedPath
      .split("/")
      .map((part) => encodeURIComponent(part))
      .join("/");
    await this.request(
      "POST",
      `/storage/v1/object/${this.config.bucket}/${encodedPath}`,
      {
        rawBody: content,
        contentType: contentType || "application/octet-stream",
        extraHeaders: { "x-upsert": upsert ? "true" : "false" },
      },
    );
  }

  async deleteObject({ objectPath }) {
    const normalizedPath = String(objectPath || "").trim().replace(/^\/+/, "");
    if (!normalizedPath) {
      return;
    }
    const encodedPath = normalizedPath
      .split("/")
      .map((part) => encodeURIComponent(part))
      .join("/");
    try {
      await this.request(
        "DELETE",
        `/storage/v1/object/${this.config.bucket}/${encodedPath}`,
        {
          prefer: "return=minimal",
        },
      );
    } catch (error) {
      const message = String(error || "").toLowerCase();
      if (message.includes("not found") || message.includes("404")) {
        return;
      }
      throw error;
    }
  }
}

