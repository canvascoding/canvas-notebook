"""Exercise the installed document/image runtime after security lock updates."""

import io
import ssl
import re
import subprocess
import sys
from pathlib import Path
from importlib.metadata import version

import certifi
import pillow_heif
from PIL import Image
from pypdf import PdfReader, PdfWriter


assert version("Pillow") == "13.0.0"
assert version("certifi") == "2026.10.23"
assert version("pypdf") == "6.21.4"
assert len(ssl.create_default_context(cafile=certifi.where()).get_ca_certs()) > 100

image = Image.new("RGB", (80, 40), (39, 85, 101))
for image_format in ("PNG", "JPEG", "TIFF", "WEBP"):
    encoded = io.BytesIO()
    image.save(encoded, format=image_format)
    encoded.seek(0)
    with Image.open(encoded) as decoded:
        decoded.load()
        assert decoded.size == image.size, image_format

heif_buffer = io.BytesIO()
pillow_heif.from_pillow(image).save(heif_buffer)
heif_buffer.seek(0)
decoded_heif = pillow_heif.open_heif(heif_buffer)
assert decoded_heif.size == image.size
assert decoded_heif.to_pillow().size == image.size

# Run the exact Python fallback shipped inside the TypeScript image converter.
converter = (Path(__file__).resolve().parents[1] / "app/lib/images/convert.ts").read_text()
fallback = re.search(r"const PYTHON_HEIC_SCRIPT = `([\s\S]*?)`;", converter)
assert fallback is not None
result = subprocess.run([sys.executable, "-c", fallback.group(1)], input=heif_buffer.getvalue(),
                        capture_output=True, timeout=30, check=True)
with Image.open(io.BytesIO(result.stdout)) as decoded_fallback:
    assert decoded_fallback.format == "PNG"
    assert decoded_fallback.size == image.size

# Exercise pypdf's Pillow-backed image extraction, not only blank-page parsing.
image_pdf = io.BytesIO()
image.save(image_pdf, format="PDF", title="Security runtime image")
reader = PdfReader(io.BytesIO(image_pdf.getvalue()))
assert len(reader.pages) == 1
assert reader.pages[0].images[0].image.size == image.size

writer = PdfWriter()
writer.append(reader)
writer.add_blank_page(width=120, height=240)
writer.pages[1].rotate(90)
writer.add_metadata({"/Title": "Security document runtime"})
writer.encrypt("test-reader", "test-owner", algorithm="AES-256")
encrypted = io.BytesIO()
writer.write(encrypted)
protected = PdfReader(io.BytesIO(encrypted.getvalue()))
assert protected.is_encrypted
assert protected.decrypt("incorrect-password") == 0
assert protected.decrypt("test-reader") != 0
assert len(protected.pages) == 2
assert protected.pages[1].rotation == 90
assert protected.metadata.title == "Security document runtime"
assert protected.pages[0].images[0].image.size == image.size

split = PdfWriter()
split.add_page(protected.pages[1])
split_buffer = io.BytesIO()
split.write(split_buffer)
assert len(PdfReader(io.BytesIO(split_buffer.getvalue())).pages) == 1
print("Python runtime: fixed versions, CA store, PNG/JPEG/TIFF/WebP/HEIF, PDF images, AES-256, rotation and split passed")
