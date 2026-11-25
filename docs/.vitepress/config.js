export default {
  title: 'GLEN',
  description: 'Map + AI Data Analyst — interactive MapLibre maps with LLM-powered data analysis.',
  base: '/glen/',

  themeConfig: {
    nav: [
      { text: 'Guide', link: '/guide/quickstart' },
      { text: 'Map Builder', link: 'https://schmidtdse.github.io/glen/maps/', target: '_blank' },
      { text: 'Releases', link: 'https://github.com/SchmidtDSE/glen/releases', target: '_blank' },
      { text: 'Live Demo', link: 'https://schmidtdse.github.io/glen/', target: '_blank' },
      { text: 'GitHub', link: 'https://github.com/SchmidtDSE/glen', target: '_blank' },
    ],

    sidebar: [
      {
        text: 'Getting Started',
        items: [
          { text: 'Quick Start', link: '/guide/quickstart' },
          { text: 'Map Builder', link: '/guide/map-builder' },
          { text: 'Configuration Reference', link: '/guide/configuration' },
          { text: 'Deployment', link: '/guide/deployment' },
          { text: 'Private Deployment', link: '/guide/private-deployment' },
          { text: 'Upgrading to v4', link: '/guide/upgrading-to-v4' },
        ],
      },
      {
        text: 'Internals',
        items: [
          { text: 'Agent Loop', link: '/guide/agent-loop' },
        ],
      },
    ],

    socialLinks: [
      { icon: 'github', link: 'https://github.com/SchmidtDSE/glen' },
    ],

    footer: {
      message: 'Released under the MIT License.',
    },

    search: {
      provider: 'local',
    },
  },
}
