"""Captura verificable de una etiqueta Dropanas usando una sesión web propia.

La API oficial no entrega el PDF de la etiqueta. Esta herramienta separada
requiere inicio de sesión manual y nunca intenta IDs de pedidos adivinados.
"""
import argparse
import asyncio
import io
import json
import re
from pathlib import Path
from urllib.parse import urlparse

from PIL import Image, ImageChops
from pypdf import PdfReader

BASE_URL = "https://app.dropanas.com"
LOGIN_URL = f"{BASE_URL}/login"
ORDERS_URL = f"{BASE_URL}/orders"
LOGIN_MARKERS = ("iniciar sesión", "inicia sesión", "login", "contraseña", "password")
ERROR_MARKERS = ("404", "no encontrado", "ocurrió un error", "access denied", "forbidden")


def compact(text):
    return re.sub(r"\s+", " ", text or "").strip().lower()


def validate_document(text, expected):
    folded = compact(text)
    if any(marker in folded for marker in LOGIN_MARKERS):
        return False, "login_detected"
    if any(marker in folded for marker in ERROR_MARKERS):
        return False, "error_page"
    if compact(expected) not in folded:
        return False, "tracking_not_verified"
    return True, "verified"


def crop_white(image, margin=18):
    rgb = image.convert("RGB")
    background = Image.new("RGB", rgb.size, (255, 255, 255))
    box = ImageChops.difference(rgb, background).getbbox()
    if not box:
        raise ValueError("blank_image")
    left, top, right, bottom = box
    return rgb.crop((max(0, left - margin), max(0, top - margin),
                     min(rgb.width, right + margin), min(rgb.height, bottom + margin)))


def pdf_text(raw):
    reader = PdfReader(io.BytesIO(raw))
    return "\n".join((page.extract_text() or "") for page in reader.pages), len(reader.pages)


def assert_dropanas_url(url):
    parsed = urlparse(url)
    if parsed.scheme != "https" or parsed.hostname != "app.dropanas.com":
        raise ValueError("guide_url_outside_dropanas")


async def page_requires_login(page):
    if "/login" in page.url:
        return True
    text = await page.locator("body").inner_text()
    return any(marker in compact(text) for marker in LOGIN_MARKERS)


async def login(session_dir):
    from playwright.async_api import async_playwright
    session_dir.mkdir(parents=True, exist_ok=True)
    async with async_playwright() as playwright:
        context = await playwright.chromium.launch_persistent_context(str(session_dir), headless=False)
        page = context.pages[0] if context.pages else await context.new_page()
        await page.goto(LOGIN_URL, wait_until="domcontentloaded")
        print("Inicia sesión manualmente. Cuando veas el panel de Dropanas, pulsa Enter aquí.", flush=True)
        await asyncio.to_thread(input)
        await page.goto(ORDERS_URL, wait_until="domcontentloaded")
        authenticated = not await page_requires_login(page)
        await context.close()
        if not authenticated:
            return {"ok": False, "status": "review_required", "reason": "login_not_confirmed"}
        return {"ok": True, "status": "session_ready", "reason": "orders_page_accessible"}


async def locate_order(page, order_id, max_pages=1000):
    await page.goto(ORDERS_URL, wait_until="domcontentloaded")
    if await page_requires_login(page):
        return None, "login_required"
    for _ in range(1, max_pages + 1):
        button = page.locator(f'button.action-btn-view[data-order-id="{order_id}"]')
        if await button.count():
            row = button.first.locator("xpath=ancestor::tr[1]")
            guide = row.locator("a.action-btn-tealca")
            if not await guide.count():
                return None, "guide_link_missing"
            href = await guide.first.get_attribute("href")
            tracking = await button.first.get_attribute("data-guia-tealca")
            local_id = await button.first.get_attribute("data-order-id")
            if local_id != str(order_id):
                return None, "order_identity_mismatch"
            if not href:
                return None, "guide_link_empty"
            guide_url = href if href.startswith("http") else f"{BASE_URL}{href}"
            assert_dropanas_url(guide_url)
            if guide_url.rstrip("/").split("/")[-1] != str(order_id):
                return None, "guide_link_order_mismatch"
            return {"order_id": local_id, "tracking": tracking, "guide_url": guide_url}, None
        next_link = page.locator('a[rel="next"]')
        if not await next_link.count():
            return None, "order_not_found"
        await next_link.first.click()
        await page.wait_for_load_state("domcontentloaded")
    return None, "page_limit_exceeded"


async def save_verified_document(context, page, guide_url, expected, output):
    response = await context.request.get(guide_url)
    content_type = response.headers.get("content-type", "").lower()
    if response.ok and "pdf" in content_type:
        raw = await response.body()
        text, pages = pdf_text(raw)
        ok, reason = validate_document(text, expected)
        if pages != 1:
            ok, reason = False, "multi_page_pdf_requires_review"
        pdf_output = output.with_suffix(".pdf")
        pdf_output.write_bytes(raw)
        return {"ok": ok, "status": "verified" if ok else "review_required",
                "reason": reason, "source": "pdf", "pages": pages, "output": str(pdf_output)}

    await page.goto(guide_url, wait_until="domcontentloaded")
    if await page_requires_login(page):
        return {"ok": False, "status": "review_required", "reason": "login_detected"}
    text = await page.locator("body").inner_text()
    ok, reason = validate_document(text, expected)
    raw = await page.screenshot(full_page=True)
    image = crop_white(Image.open(io.BytesIO(raw)))
    if image.width < 200 or image.height < 200:
        ok, reason = False, "incomplete_image"
    image.save(output, "JPEG", quality=92)
    return {"ok": ok, "status": "verified" if ok else "review_required",
            "reason": reason, "source": "screenshot", "size": [image.width, image.height],
            "output": str(output)}


async def capture(order_id, expected, session_dir, output):
    from playwright.async_api import async_playwright
    if not session_dir.exists():
        return {"ok": False, "status": "review_required", "reason": "login_required"}
    async with async_playwright() as playwright:
        context = await playwright.chromium.launch_persistent_context(str(session_dir), headless=True)
        page = context.pages[0] if context.pages else await context.new_page()
        order, reason = await locate_order(page, str(order_id))
        if not order:
            await context.close()
            return {"ok": False, "status": "review_required", "reason": reason}
        if compact(order.get("tracking")) != compact(expected):
            await context.close()
            return {"ok": False, "status": "review_required", "reason": "row_tracking_mismatch"}
        result = await save_verified_document(context, page, order["guide_url"], expected, output)
        result.update({"order_id": str(order_id), "tracking": expected})
        await context.close()
        return result


def parser():
    common = argparse.ArgumentParser(add_help=False)
    common.add_argument("--session-dir", default="data/dropanas-browser-session")
    root = argparse.ArgumentParser(description="Sesión y captura verificable de guías Dropanas")
    commands = root.add_subparsers(dest="command", required=True)
    commands.add_parser("login", parents=[common], help="Crear o renovar la sesión manual")
    capture_parser = commands.add_parser("capture", parents=[common], help="Capturar un pedido concreto")
    capture_parser.add_argument("--order-id", required=True)
    capture_parser.add_argument("--expected-tracking", required=True)
    capture_parser.add_argument("--output", required=True)
    capture_parser.add_argument("--authorized", action="store_true")
    return root


def main():
    args = parser().parse_args()
    session_dir = Path(args.session_dir).resolve()
    if args.command == "login":
        result = asyncio.run(login(session_dir))
    else:
        if not args.authorized:
            raise SystemExit("Bloqueado: use --authorized solo para un pedido concreto autorizado")
        output = Path(args.output).resolve()
        output.parent.mkdir(parents=True, exist_ok=True)
        result = asyncio.run(capture(args.order_id, args.expected_tracking, session_dir, output))
    print(json.dumps(result, ensure_ascii=False))
    raise SystemExit(0 if result.get("ok") else 2)


if __name__ == "__main__":
    main()
