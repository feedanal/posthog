import { useValues } from 'kea'
import { useEffect, useState } from 'react'

import { heatmapLogic } from '~/toolbar/elements/heatmapLogic'

import { toolbarConfigLogic } from '../toolbarConfigLogic'

function ScrollDepthMouseInfo(): JSX.Element | null {
    const { posthog } = useValues(toolbarConfigLogic)
    const { scrollmapElements } = useValues(heatmapLogic)

    // Track the mouse position and render an indicator about how many people have scrolled to this point
    const [mouseY, setMouseY] = useState<null | number>(0)

    useEffect(() => {
        const onMove = (e: MouseEvent): void => {
            setMouseY(e.clientY)
        }

        window.addEventListener('mousemove', onMove)
        return () => {
            window.removeEventListener('mousemove', onMove)
        }
    }, [])

    if (!scrollmapElements.length || !mouseY) {
        return null
    }

    const scrollOffset = (posthog as any).scrollManager.scrollY()
    const scrolledMouseY = mouseY + scrollOffset

    const elementInMouseY = scrollmapElements.find((x, i) => {
        const lastY = scrollmapElements[i - 1]?.y ?? 0
        return scrolledMouseY >= lastY && scrolledMouseY < x.y
    })

    const percentage = ((elementInMouseY?.count ?? 0) / scrollmapElements[0].count) * 100

    return (
        <div
            className="absolute left-0 right-0 flex items-center"
            // eslint-disable-next-line react/forbid-dom-props
            style={{
                top: mouseY,
                transform: 'translateY(-50%)',
            }}
        >
            <div className="border-b w-full" />
            <div className="bg-border whitespace-nowrap text-default rounded p-2 font-semibold">
                {percentage.toPrecision(4)}% scrolled this far
            </div>

            <div className="border-b w-10" />
        </div>
    )
}

export function ScrollDepth(): JSX.Element | null {
    const { posthog } = useValues(toolbarConfigLogic)
    const { heatmapEnabled, heatmapFilter, scrollmapElements } = useValues(heatmapLogic)

    if (!heatmapEnabled || !heatmapFilter.scrolldepth || !scrollmapElements.length) {
        return null
    }

    // Remove as any once we have the scrollmanager stuff merged
    const ph = posthog as any

    const scrollOffset = ph.scrollManager.scrollY()

    // We want to have a fading color from red to orange to green to blue to grey, fading from the highest coun to the lowest

    const maxCount = scrollmapElements[0].count

    function color(count: number): string {
        const value = 1 - count / maxCount

        const safeValue = Math.max(0, Math.min(1, value))

        // Calculate hue

        const hue = Math.round(260 * safeValue)

        // Return hsl color. You can adjust saturation and lightness to your liking
        return `hsl(${hue}, 100%, 50%)`
    }

    return (
        <div className="fixed inset-0 overflow-hidden">
            <div
                className="absolute top-0 left-0 right-0"
                // eslint-disable-next-line react/forbid-dom-props
                style={{
                    transform: `translateY(${-scrollOffset}px)`,
                }}
            >
                {scrollmapElements.map(({ y, count }, i) => (
                    <div
                        key={y}
                        // eslint-disable-next-line react/forbid-dom-props
                        style={{
                            position: 'absolute',
                            top: scrollmapElements[i - 1]?.y ?? 0,
                            left: 0,
                            width: '100%',
                            height: y - (scrollmapElements[i - 1]?.y ?? 0),
                            backgroundColor: color(count),
                            opacity: 0.5,
                        }}
                    />
                ))}
            </div>
            <ScrollDepthMouseInfo />
        </div>
    )
}