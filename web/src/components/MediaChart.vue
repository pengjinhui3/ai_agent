<script setup>
import { onMounted, onBeforeUnmount, ref, watch } from 'vue'
import * as echarts from 'echarts/core'
import { BarChart, LineChart, PieChart } from 'echarts/charts'
import { GridComponent, TooltipComponent, LegendComponent, TitleComponent } from 'echarts/components'
import { CanvasRenderer } from 'echarts/renderers'

/**
 * media_chart 富媒体段渲染组件（09 图表方案）。
 *
 * ECharts 按需引入（tree-shaking：bar/line/pie + 基础组件 + Canvas）；
 * 实例生命周期随组件（init / option 更新 / resize 自适应 / dispose）——
 * 真组件挂载模式，无 v-html DOM 扫描的重建与泄漏问题。
 */
echarts.use([BarChart, LineChart, PieChart, GridComponent, TooltipComponent, LegendComponent, TitleComponent, CanvasRenderer])

const props = defineProps({
  /** ECharts option（Map/对象，来自 media_json 条目 data 或 SSE MEDIA_END mediaData） */
  option: { type: Object, required: true }
})

const el = ref(null)
let chart = null
let resizeObserver = null

onMounted(() => {
  chart = echarts.init(el.value)
  chart.setOption(props.option)
  resizeObserver = new ResizeObserver(() => chart && chart.resize())
  resizeObserver.observe(el.value)
})

watch(() => props.option, val => {
  if (chart && val) {
    chart.setOption(val, true) // notMerge：整卡替换（历史回放切换场景）
  }
})

onBeforeUnmount(() => {
  if (resizeObserver) {
    resizeObserver.disconnect()
    resizeObserver = null
  }
  if (chart) {
    chart.dispose()
    chart = null
  }
})
</script>

<template>
  <div ref="el" class="media-chart-box"></div>
</template>

<style scoped>
.media-chart-box {
  width: 100%;
  height: 320px;
}
</style>
