# Third-party data

## HuBMAP Human Reference Atlas — 3D reference organs (CC BY 4.0)

The regional models `content/regions/chest.json`, `abdomen.json`, `upper-back.json`, `sacrum-buttock.json` and
`neck-anterior.json`, and the measurements in `tools/anatomy/derived/vh-male.json`, are derived from:

> Kristen Browne, Heidi Schlehlein, Bruce W. Herr II, Ellen Quardokus, Andreas Bueckle, Katy Börner. *HuBMAP CCF 3D
> Reference Object Library*: Visible Human Male united body, CCF release v1.3.
> https://humanatlas.io/3d-reference-library ·
> https://github.com/hubmapconsortium/ccf-releases (commit b036a91aaf7234f462b1249d4a5f4fb0e982f412)

Licensed under the Creative Commons Attribution 4.0 International licence
(https://creativecommons.org/licenses/by/4.0/). The reference organs were created from data of the Visible Human
Project of the US National Library of Medicine. Changes: the meshes were sampled (skin cross-sections, rays cast from
the skin, bony landmarks) into two-dimensional regional charts with depth; schematic anatomy was added where the
reference body has none (docs/ANATOMY.md §8). The meshes themselves are not redistributed: `tools/anatomy/fetch_hra.py`
downloads them.

## Software used to make and check the clinic's models

The equipment models in `content/world/assets/models` are AcuCraft's own work (MIT, as its code), written as code in
`tools/blender/models.py`. They are built with [Blender](https://www.blender.org/) (GPL; its `bpy` module — a tool,
nothing of it is redistributed) through the Blender bridge and shape kit of the pinned
[ClinicalCraft](https://github.com/psknlr/ClinicalCraft) checkout, and fitted to the bodies its figure kit draws.
[three.js](https://threejs.org/) (MIT) is a development dependency: `tools/figure-fit.mts` runs ClinicalCraft's figure
kit with it. Neither ships in a content pack or in the engine.

## WHO standards

Point codes and names follow the WHO Standard Acupuncture Point Locations in the Western Pacific Region (2008) and the
WHO standard international acupuncture nomenclature (1991). Locations in `content/acupoints/` are paraphrases written
for this project, not the standards' text.
