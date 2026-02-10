# bni_palms
BNI PALMS reporting tool.

## Run locally
1. Install Python 3.10+.
2. Install dependencies:

```bash
python -m pip install -r requirements.txt
```

3. Start the server:

```bash
python -m uvicorn app.main:app --reload
```

Then open `http://127.0.0.1:8000`.

## Uploads
Files are stored locally under `uploads/<chapter>/<report_type>/` with a timestamped filename.

## Chapters list
Update the chapter dropdown by editing `chapters.json`:

```json
{
  "chapters": ["St. Charles", "Abundant Connections"]
}
```
