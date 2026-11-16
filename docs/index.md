---
layout: home

hero:
  name: GLEN
  text: Map + AI Data Analyst
  tagline: Build interactive map applications with LLM-powered data analysis — no JavaScript required.
  actions:
    - theme: brand
      text: Quick Start
      link: /guide/quickstart
    - theme: alt
      text: Live Demo
      link: https://padus.nrp-nautilus.io/
    - theme: alt
      text: Template Repo
      link: https://github.com/SchmidtDSE/glen-template

features:
  - title: Zero JavaScript
    details: Your app is just three files — index.html, layers-input.json, and system-prompt.md. glen core and its plugins load from CDN.
  - title: Portolan and STAC catalogs
    details: Point at a catalog and the agent shows, filters and styles its layers. The MCP plugin adds SQL over H3-indexed Parquet with DuckDB.
  - title: Reports you can re-run
    details: Save a session as a Quarto-style report — the SQL the agent ran as R, Python or SQL chunks with their output, charts, the final map, and a disclosure of the model used.
  - title: Flexible deployment
    details: GitHub Pages with user-supplied API keys, Hugging Face Spaces with a secret config, or Kubernetes with server-injected credentials.
---
