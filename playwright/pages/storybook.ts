import { expect, Locator, Page } from '@playwright/test'

const STORYBOOK_URL: string = process.env.STORYBOOK_URL?.endsWith('/')
    ? process.env.STORYBOOK_URL.slice(0, -1)
    : process.env.STORYBOOK_URL || 'http://localhost:6006'

const PSEUDO_STATES = {
    hover: 'hover',
    active: 'active',
    focusVisible: 'focus-visible',
    focusWithin: 'focus-within',
    focus: 'focus',
    visited: 'visited',
    link: 'link',
    target: 'target',
}

type ComponentScreenshotConfig = {
    pseudo?: Partial<Record<keyof typeof PSEUDO_STATES, boolean>>
}

export class StorybookStoryPage {
    readonly page: Page
    readonly mainAppContent: Locator
    readonly storyRoot: Locator

    constructor(page: Page) {
        this.page = page
        this.mainAppContent = page.locator('.main-app-content')
        this.storyRoot = page.locator('#root')
    }

    async goto(storyId: string): Promise<void> {
        const storyUrl = `${STORYBOOK_URL}/iframe.html?id=${storyId}&viewMode=story`
        await this.page.goto(storyUrl, { waitUntil: 'networkidle' })
    }

    async resizeToMobile(): Promise<void> {
        await this.page.setViewportSize({ width: 375, height: 667 }) // iPhone 6/7/8
    }

    async expectFullPageScreenshot(): Promise<void> {
        await expect(this.page).toHaveScreenshot({ maxDiffPixelRatio: 0.01 })
    }

    async expectSceneScreenshot(): Promise<void> {
        await expect(this.mainAppContent).toHaveScreenshot({ maxDiffPixelRatio: 0.01 })
    }

    async expectComponentScreenshot({ pseudo } = {} as ComponentScreenshotConfig): Promise<void> {
        const pseudoClasses = Object.entries(pseudo || {}).flatMap(([state, enabled]) => {
            return enabled ? `pseudo-${PSEUDO_STATES[state]}` : []
        })

        await this.page.evaluate(
            ([pseudoClasses]) => {
                const rootEl = document.getElementById('root')

                if (rootEl) {
                    // don't expand the container element to limit the screenshot
                    // to the component's size
                    rootEl.style.display = 'inline-block'

                    // add classes for pseudo states generated by
                    // storybook-addon-pseudo-states
                    pseudoClasses.forEach((c) => {
                        rootEl.classList.add(c)
                    })
                }

                // make the body transparent to take the screenshot
                // without background
                document.body.style.background = 'transparent'
            },
            [pseudoClasses]
        )

        await expect(this.storyRoot).toHaveScreenshot({ omitBackground: true, maxDiffPixelRatio: 0.01 })
    }
}
