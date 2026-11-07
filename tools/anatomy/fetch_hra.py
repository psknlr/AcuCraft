"""Downloads the pinned HuBMAP Human Reference Atlas Visible Human Male united body into tools/anatomy/.cache (not
committed).

    python3 tools/anatomy/fetch_hra.py

Source: hubmapconsortium/ccf-releases at a fixed commit, v1.3 models. Licence: CC BY 4.0 (attribution: Kristen
Browne, Heidi Schlehlein, Bruce W. Herr II, Ellen Quardokus, Andreas Bueckle, Katy Börner, HuBMAP CCF 3D Reference
Object Library, humanatlas.io/3d-reference-library; data from the Visible Human Project, US National Library of
Medicine). The archive is checked against its SHA-256 before it is unpacked.
"""
import hashlib
import os
import sys
import urllib.request
import zipfile

COMMIT = "b036a91aaf7234f462b1249d4a5f4fb0e982f412"
BASE = f"https://raw.githubusercontent.com/hubmapconsortium/ccf-releases/{COMMIT}/v1.3/models/"
FILES = {
    "VH_M_United.glb.zip": ("0cd617ab042e3e3a5793e4e612d3b3eeb2a2df10028f2213df050d94da53d2df", "VH_M_United.glb"),
}
CACHE = os.path.join(os.path.dirname(os.path.abspath(__file__)), ".cache")


def main():
    os.makedirs(CACHE, exist_ok=True)
    for name, (sha, member) in FILES.items():
        target = os.path.join(CACHE, member)
        if os.path.exists(target):
            print(f"have {member}")
            continue
        archive = os.path.join(CACHE, name)
        if not os.path.exists(archive):
            print(f"downloading {name} …")
            urllib.request.urlretrieve(BASE + name, archive)
        digest = hashlib.sha256(open(archive, "rb").read()).hexdigest()
        if digest != sha:
            os.remove(archive)
            sys.exit(f"{name}: checksum mismatch ({digest})")
        with zipfile.ZipFile(archive) as zf:
            zf.extract(member, CACHE)
        os.remove(archive)
        print(f"unpacked {member}")


if __name__ == "__main__":
    main()
