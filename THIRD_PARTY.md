\# Third Party Notices



PixelLyrics includes portions of code and protocol knowledge derived from third-party open source projects.



This file documents third-party components, their original authors, license information, and the parts used in PixelLyrics.



\---



\## halo-pixelbar-mcp



Repository:

`Seraph310/halo-pixelbar-mcp`



License:

MIT License



Copyright:



```

Copyright (c) 2026 Seraph310

```



Usage in PixelLyrics:



\* `app/src/halo/constants.js`

\* `app/src/halo/packets.js`

\* `app/src/halo/device.js` (device identification and filtering logic)

\* Related Halo protocol tests



Description:



PixelLyrics uses portions of the Halo PixelBar protocol implementation originally developed in `halo-pixelbar-mcp`.



The following parts were adapted:



\* Device identification constants

\* HID packet construction

\* Packet checksum calculation

\* Layout and scene protocol definitions

\* UTF-8 text packet handling



These portions have been modified and integrated into PixelLyrics.



The original project is licensed under the MIT License. The original copyright notice is preserved here in accordance with the license requirements.



\---



\## watch-heart-desktop



Repository:

`HDZ123321/watch-heart-desktop`



License declaration:

MIT License (declared by the upstream project)



License status:



The upstream repository declares MIT licensing through project documentation, but a standalone LICENSE file was not present in the reviewed source snapshot.



Usage in PixelLyrics:



\* `app/src/lyrics/soda-lyrics-inject.js`

\* `app/src/lyrics/soda-lyrics-service.js`



Description:



PixelLyrics adapts parts of the Soda Music lyrics bridge implementation from `watch-heart-desktop`.



Adapted functionality includes:



\* Soda Music bridge communication

\* Local HTTP bridge handling

\* Token generation and validation logic

\* asar extraction and injection workflow

\* Soda Music process/path detection



The adapted code has been modified to integrate with PixelLyrics and the Halo PixelBar display pipeline.



The upstream project attribution is retained here based on its declared MIT license.



\---



\## HaloLyricSync



Repository:

`nxz1026/HaloLyricSync`



License declaration:

MIT License (declared by upstream documentation)



License status:



The upstream repository documentation declares MIT licensing, but a LICENSE file was not present in the reviewed source snapshot.



Usage in PixelLyrics:



\* `app/src/halo/ec-packets.js`

\* `app/tests/test\_halo\_ec\_protocol.js`



Description:



PixelLyrics includes experimental protocol research code adapted from HaloLyricSync.



Adapted functionality includes:



\* EC protocol packet format

\* Text color definitions

\* Layout byte definitions

\* Packet checksum calculation



This module is experimental and is not part of the main production display pipeline.



Additional protocol references:



HaloLyricSync references compatibility with:



\* `XFEstudio/HaloPixelToolBox`



Any protocol naming or compatibility information should be considered part of the related open protocol ecosystem.



\---



\## Runtime Dependencies



PixelLyrics also uses third-party packages distributed under their respective licenses.



Examples include:



\* Electron

\* node-hid

\* windows-media-sessions

\* @electron/asar

\* electron-builder



The licenses of these dependencies are provided by their respective projects and package distributions.



\---



\## License Summary



| Component           | License Status                                                      | Used For                                |

| ------------------- | ------------------------------------------------------------------- | --------------------------------------- |

| halo-pixelbar-mcp   | MIT                                                                 | Halo ED protocol implementation         |

| watch-heart-desktop | MIT declared by upstream, LICENSE file not found in reviewed source | Soda Music lyrics bridge                |

| HaloLyricSync       | MIT declared by upstream, LICENSE file not found in reviewed source | Experimental EC protocol implementation |

| PixelLyrics         | MIT                                                                 | Main project code                       |



\---



\## Notes



PixelLyrics is not a direct copy of any complete third-party repository.



Third-party components have been selectively adapted and modified.



Project-specific implementations, including:



\* lyric processing pipeline

\* display scheduling strategy

\* device ownership management

\* application lifecycle handling

\* user interface

\* Halo device integration logic



are original PixelLyrics implementations.



For complete license texts, please refer to the original upstream repositories.



