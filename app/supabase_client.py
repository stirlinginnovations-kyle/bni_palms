import json
import os
from dataclasses import dataclass
from typing import Any, Dict, List, Optional
from urllib import error, parse, request


class SupabaseError(RuntimeError):
    pass


@dataclass(frozen=True)
class SupabaseConfig:
    url: str
    service_key: str
    bucket: str = "chapter-reports"


class SupabaseClient:
    def __init__(self, config: SupabaseConfig):
        self.config = config
        self.base_url = config.url.rstrip("/")

    @classmethod
    def from_env(cls) -> Optional["SupabaseClient"]:
        url = os.getenv("SUPABASE_URL", "").strip()
        service_key = (
            os.getenv("SUPABASE_SERVICE_ROLE_KEY", "").strip()
            or os.getenv("SUPABASE_SERVICE_KEY", "").strip()
            or os.getenv("SUPABASE_SECRET_KEY", "").strip()
        )
        bucket = os.getenv("SUPABASE_STORAGE_BUCKET", "chapter-reports").strip()
        if not url or not service_key:
            return None
        return cls(SupabaseConfig(url=url, service_key=service_key, bucket=bucket))

    def _request(
        self,
        method: str,
        path: str,
        *,
        query: Optional[Dict[str, str]] = None,
        json_body: Optional[Any] = None,
        raw_body: Optional[bytes] = None,
        content_type: Optional[str] = None,
        prefer: Optional[str] = None,
        extra_headers: Optional[Dict[str, str]] = None,
    ) -> Any:
        if json_body is not None and raw_body is not None:
            raise SupabaseError("Cannot send json_body and raw_body at the same time.")

        url = f"{self.base_url}{path}"
        if query:
            url = f"{url}?{parse.urlencode(query, doseq=True)}"

        body: Optional[bytes] = None
        if json_body is not None:
            body = json.dumps(json_body).encode("utf-8")
            content_type = "application/json"
        elif raw_body is not None:
            body = raw_body

        headers = {
            "apikey": self.config.service_key,
            "Authorization": f"Bearer {self.config.service_key}",
        }
        if content_type:
            headers["Content-Type"] = content_type
        if prefer:
            headers["Prefer"] = prefer
        if extra_headers:
            headers.update(extra_headers)

        req = request.Request(url, data=body, method=method.upper(), headers=headers)
        try:
            with request.urlopen(req, timeout=60) as resp:
                payload = resp.read()
                if not payload:
                    return None
                resp_content_type = resp.headers.get("Content-Type", "")
                if "application/json" in resp_content_type:
                    return json.loads(payload.decode("utf-8"))
                return payload
        except error.HTTPError as exc:
            body_text = exc.read().decode("utf-8", "ignore")
            detail = body_text.strip()
            try:
                parsed = json.loads(body_text)
                if isinstance(parsed, dict):
                    detail = (
                        str(parsed.get("message"))
                        if parsed.get("message")
                        else str(parsed.get("error") or parsed)
                    )
                else:
                    detail = str(parsed)
            except json.JSONDecodeError:
                pass
            raise SupabaseError(
                f"{method.upper()} {path} failed with {exc.code}: {detail}"
            ) from exc
        except Exception as exc:  # pragma: no cover - network/runtime errors
            raise SupabaseError(f"{method.upper()} {path} failed: {exc}") from exc

    def list_active_chapters(self) -> List[str]:
        rows = self._request(
            "GET",
            "/rest/v1/chapters",
            query={"select": "name", "is_active": "eq.true", "order": "name.asc"},
        )
        if not isinstance(rows, list):
            return []
        output: List[str] = []
        for row in rows:
            name = str(row.get("name", "")).strip()
            if name:
                output.append(name)
        return output

    def get_chapter_upload_pin(self, *, chapter_slug: str) -> Optional[str]:
        rows = self._request(
            "GET",
            "/rest/v1/chapter_upload_pins",
            query={
                "select": "chapter_pin",
                "chapter_slug": f"eq.{chapter_slug}",
                "limit": "1",
            },
        )
        if isinstance(rows, list) and rows:
            chapter_pin = str(rows[0].get("chapter_pin", "")).strip()
            if chapter_pin:
                return chapter_pin
        return None

    def upsert_chapter_upload_pin(
        self,
        *,
        chapter_slug: str,
        chapter_name: str,
        chapter_pin: str,
    ) -> Dict[str, Any]:
        rows = self._request(
            "POST",
            "/rest/v1/chapter_upload_pins",
            query={
                "on_conflict": "chapter_slug",
                "select": "chapter_slug,chapter_name,chapter_pin,updated_at",
            },
            json_body=[
                {
                    "chapter_slug": chapter_slug,
                    "chapter_name": chapter_name,
                    "chapter_pin": chapter_pin,
                }
            ],
            prefer="resolution=merge-duplicates,return=representation",
        )
        if isinstance(rows, list) and rows:
            return dict(rows[0])
        raise SupabaseError("Failed to upsert chapter_upload_pins row.")

    def get_chapter_yearly_goals(self, *, chapter_slug: str) -> Optional[Dict[str, Any]]:
        rows = self._request(
            "GET",
            "/rest/v1/chapter_yearly_goals",
            query={
                "select": "chapter_slug,chapter_name,visitors,one_to_ones,referrals,ceu,tyfcb",
                "chapter_slug": f"eq.{chapter_slug}",
                "limit": "1",
            },
        )
        if isinstance(rows, list) and rows:
            return dict(rows[0])
        return None

    def upsert_chapter_yearly_goals(
        self,
        *,
        chapter_slug: str,
        chapter_name: str,
        visitors: float,
        one_to_ones: float,
        referrals: float,
        ceu: float,
        tyfcb: float,
    ) -> Dict[str, Any]:
        rows = self._request(
            "POST",
            "/rest/v1/chapter_yearly_goals",
            query={
                "on_conflict": "chapter_slug",
                "select": "chapter_slug,chapter_name,visitors,one_to_ones,referrals,ceu,tyfcb,updated_at",
            },
            json_body=[
                {
                    "chapter_slug": chapter_slug,
                    "chapter_name": chapter_name,
                    "visitors": visitors,
                    "one_to_ones": one_to_ones,
                    "referrals": referrals,
                    "ceu": ceu,
                    "tyfcb": tyfcb,
                }
            ],
            prefer="resolution=merge-duplicates,return=representation",
        )
        if isinstance(rows, list) and rows:
            return dict(rows[0])
        raise SupabaseError("Failed to upsert chapter_yearly_goals row.")

    def get_chapter_by_slug(self, slug: str) -> Optional[Dict[str, Any]]:
        rows = self._request(
            "GET",
            "/rest/v1/chapters",
            query={
                "select": "id,name,slug",
                "slug": f"eq.{slug}",
                "limit": "1",
            },
        )
        if isinstance(rows, list) and rows:
            return dict(rows[0])
        return None

    def get_latest_chapter_upload(
        self, *, chapter_id: str, report_type: str
    ) -> Optional[Dict[str, Any]]:
        rows = self._request(
            "GET",
            "/rest/v1/chapter_report_uploads",
            query={
                "select": "id,chapter_id,report_type,storage_path,uploaded_at,validation",
                "chapter_id": f"eq.{chapter_id}",
                "report_type": f"eq.{report_type}",
                "order": "uploaded_at.desc,id.desc",
                "limit": "1",
            },
        )
        if isinstance(rows, list) and rows:
            return dict(rows[0])
        return None

    def get_chapter_member_rows_for_upload(self, upload_id: int) -> List[Dict[str, Any]]:
        rows = self._request(
            "GET",
            "/rest/v1/chapter_report_member_rows",
            query={
                "select": (
                    "first_name,last_name,member_key,p,a,l,m,s,"
                    "rgi,rgo,rri,rro,v,one_to_one,tyfcb,ceu,referrals_total"
                ),
                "upload_id": f"eq.{upload_id}",
                "order": "last_name.asc,first_name.asc",
            },
        )
        if isinstance(rows, list):
            return [dict(row) for row in rows]
        return []

    def get_latest_traffic_upload(self) -> Optional[Dict[str, Any]]:
        rows = self._request(
            "GET",
            "/rest/v1/traffic_light_uploads",
            query={
                "select": "id,report_month,storage_path,uploaded_at",
                "order": "report_month.desc,uploaded_at.desc,id.desc",
                "limit": "1",
            },
        )
        if isinstance(rows, list) and rows:
            return dict(rows[0])
        return None

    def get_latest_nonempty_traffic_upload(self) -> Optional[Dict[str, Any]]:
        member_rows = self._request(
            "GET",
            "/rest/v1/traffic_light_member_rows",
            query={
                "select": "traffic_upload_id,report_month",
                "order": "report_month.desc,traffic_upload_id.desc",
                "limit": "1",
            },
        )
        if not isinstance(member_rows, list) or not member_rows:
            return None

        traffic_upload_id = member_rows[0].get("traffic_upload_id")
        if traffic_upload_id is None:
            return None

        uploads = self._request(
            "GET",
            "/rest/v1/traffic_light_uploads",
            query={
                "select": "id,report_month,storage_path,uploaded_at",
                "id": f"eq.{traffic_upload_id}",
                "limit": "1",
            },
        )
        if isinstance(uploads, list) and uploads:
            return dict(uploads[0])
        return None

    def get_traffic_rows_for_upload(
        self, *, traffic_upload_id: int, chapter_slug: str
    ) -> List[Dict[str, Any]]:
        rows = self._request(
            "GET",
            "/rest/v1/traffic_light_member_rows",
            query={
                "select": "first_name,last_name,member_key,referrals,raw",
                "traffic_upload_id": f"eq.{traffic_upload_id}",
                "chapter_slug": f"eq.{chapter_slug}",
                "order": "last_name.asc,first_name.asc",
            },
        )
        if isinstance(rows, list):
            return [dict(row) for row in rows]
        return []

    def upsert_chapter(self, *, name: str, slug: str) -> Dict[str, Any]:
        rows = self._request(
            "POST",
            "/rest/v1/chapters",
            query={"on_conflict": "slug", "select": "id,name,slug"},
            json_body=[{"name": name, "slug": slug, "is_active": True}],
            prefer="resolution=merge-duplicates,return=representation",
        )
        if isinstance(rows, list) and rows:
            return dict(rows[0])
        raise SupabaseError("Failed to upsert chapter row.")

    def insert_chapter_report_upload(self, payload: Dict[str, Any]) -> Dict[str, Any]:
        rows = self._request(
            "POST",
            "/rest/v1/chapter_report_uploads",
            query={"select": "id,chapter_id,report_type,storage_path,uploaded_at"},
            json_body=[payload],
            prefer="return=representation",
        )
        if isinstance(rows, list) and rows:
            return dict(rows[0])
        raise SupabaseError("Failed to insert chapter_report_uploads row.")

    def delete_chapter_report_uploads_except(
        self, *, chapter_id: str, report_type: str, keep_upload_id: int
    ) -> None:
        self._request(
            "DELETE",
            "/rest/v1/chapter_report_uploads",
            query={
                "chapter_id": f"eq.{chapter_id}",
                "report_type": f"eq.{report_type}",
                "id": f"neq.{keep_upload_id}",
            },
            prefer="return=minimal",
        )

    def list_chapter_report_uploads(
        self, *, chapter_id: str, report_type: str
    ) -> List[Dict[str, Any]]:
        rows = self._request(
            "GET",
            "/rest/v1/chapter_report_uploads",
            query={
                "select": "id,storage_path",
                "chapter_id": f"eq.{chapter_id}",
                "report_type": f"eq.{report_type}",
                "order": "uploaded_at.desc,id.desc",
            },
        )
        if isinstance(rows, list):
            return [dict(row) for row in rows]
        return []

    def insert_chapter_report_member_rows(self, rows: List[Dict[str, Any]]) -> int:
        return self._insert_rows("chapter_report_member_rows", rows)

    def upsert_traffic_light_upload(self, payload: Dict[str, Any]) -> Dict[str, Any]:
        rows = self._request(
            "POST",
            "/rest/v1/traffic_light_uploads",
            query={"on_conflict": "report_month", "select": "id,report_month,storage_path"},
            json_body=[payload],
            prefer="resolution=merge-duplicates,return=representation",
        )
        if isinstance(rows, list) and rows:
            return dict(rows[0])
        raise SupabaseError("Failed to upsert traffic_light_uploads row.")

    def delete_traffic_light_member_rows(self, traffic_upload_id: int) -> None:
        self._request(
            "DELETE",
            "/rest/v1/traffic_light_member_rows",
            query={"traffic_upload_id": f"eq.{traffic_upload_id}"},
            prefer="return=minimal",
        )

    def insert_traffic_light_member_rows(self, rows: List[Dict[str, Any]]) -> int:
        return self._insert_rows("traffic_light_member_rows", rows)

    def upload_object(
        self,
        *,
        object_path: str,
        content: bytes,
        content_type: str,
        upsert: bool = False,
    ) -> None:
        object_path = object_path.strip().lstrip("/")
        if not object_path:
            raise SupabaseError("Storage object path cannot be blank.")
        encoded_path = parse.quote(object_path, safe="/")
        self._request(
            "POST",
            f"/storage/v1/object/{self.config.bucket}/{encoded_path}",
            raw_body=content,
            content_type=content_type or "application/octet-stream",
            extra_headers={"x-upsert": "true" if upsert else "false"},
        )

    def delete_object(self, *, object_path: str) -> None:
        object_path = object_path.strip().lstrip("/")
        if not object_path:
            return
        encoded_path = parse.quote(object_path, safe="/")
        try:
            self._request(
                "DELETE",
                f"/storage/v1/object/{self.config.bucket}/{encoded_path}",
                prefer="return=minimal",
            )
        except SupabaseError as exc:
            msg = str(exc).lower()
            if "not found" in msg or "404" in msg:
                return
            raise

    def _insert_rows(self, table: str, rows: List[Dict[str, Any]]) -> int:
        if not rows:
            return 0
        inserted = 0
        batch_size = 500
        for idx in range(0, len(rows), batch_size):
            batch = rows[idx : idx + batch_size]
            self._request(
                "POST",
                f"/rest/v1/{table}",
                json_body=batch,
                prefer="return=minimal",
            )
            inserted += len(batch)
        return inserted
