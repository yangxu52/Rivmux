<script setup lang="ts">
import { computed, onBeforeUnmount, shallowRef, useTemplateRef } from 'vue'
import { RivmuxPlayer } from 'rivmux'

import type { PlayerError } from 'rivmux'

const url = shallowRef('http://localhost:3000/v1/stream/123456')
const statusMessage = shallowRef('等待创建流')
const isBusy = shallowRef(false)
const player = shallowRef<RivmuxPlayer>()
const playerRef = useTemplateRef<HTMLVideoElement>('playerRef')

const sourceUrl = computed(() => url.value.trim())
const canOpenPlayer = computed(() => sourceUrl.value.length > 0 && !isBusy.value)
const canClosePlayer = computed(() => player.value !== undefined && !isBusy.value)

async function handleOpenPlayer() {
  if (!canOpenPlayer.value) {
    return
  }

  const video = playerRef.value
  if (video === null) {
    statusMessage.value = '视频元素未就绪'
    return
  }

  isBusy.value = true
  statusMessage.value = '正在创建播放器'

  let nextPlayer: RivmuxPlayer | undefined
  try {
    await destroyCurrentPlayer()

    nextPlayer = new RivmuxPlayer(sourceUrl.value)
    nextPlayer.on('mediaInfo', handleMediaInfo)
    nextPlayer.on('error', handlePlayerError)
    player.value = nextPlayer

    await nextPlayer.attach(video)
    statusMessage.value = '播放器已创建，正在启动'
    await nextPlayer.start()
    statusMessage.value = '播放器已启动'
  } catch (cause) {
    if (player.value === nextPlayer) {
      player.value = undefined
    }

    await nextPlayer?.destroy().catch(() => undefined)
    statusMessage.value = `启动失败: ${formatCause(cause)}`
  } finally {
    isBusy.value = false
  }
}

async function handleClosePlayer() {
  if (!canClosePlayer.value) {
    return
  }

  isBusy.value = true
  statusMessage.value = '正在关闭播放器'

  try {
    await destroyCurrentPlayer()
    statusMessage.value = '播放器已关闭'
  } catch (cause) {
    statusMessage.value = `关闭失败: ${formatCause(cause)}`
  } finally {
    isBusy.value = false
  }
}

function handleMediaInfo() {
  statusMessage.value = '播放器已开始接收媒体信息'
}

function handlePlayerError(payload: PlayerError) {
  statusMessage.value = `错误(${payload.code}): ${payload.message}`
}

async function destroyCurrentPlayer() {
  const currentPlayer = player.value
  if (currentPlayer === undefined) {
    return
  }

  player.value = undefined

  try {
    await currentPlayer.destroy()
  } catch (cause) {
    player.value = currentPlayer
    throw cause
  }
}

function formatCause(cause: unknown) {
  if (cause instanceof Error) {
    return cause.message
  }

  return String(cause)
}

onBeforeUnmount(() => {
  void destroyCurrentPlayer()
})
</script>

<template>
  <main class="page">
    <section class="panel panel--video">
      <div class="video-wrapper">
        <video ref="playerRef" class="player"></video>
      </div>
    </section>

    <section class="panel panel--controls">
      <h1 class="title">Rivmux Playground</h1>
      <p class="hint">输入 HTTP-FLV 流 URL。</p>

      <div class="grid">
        <label class="field">
          <span class="field-label">HTTP-FLV URL</span>
          <input class="input" v-model="url" placeholder="http://localhost:3000/v1/stream/123456" />
        </label>
      </div>

      <div class="actions">
        <button class="button" :disabled="!canOpenPlayer" @click="handleOpenPlayer">播放</button>
        <button class="button button--secondary" :disabled="!canClosePlayer" @click="handleClosePlayer">停止</button>
      </div>

      <p class="status">{{ statusMessage }}</p>
    </section>
  </main>
</template>

<style scoped>
.page {
  width: min(100%, 1600px);
  min-height: 100dvh;
  margin: 0 auto;
  padding: 24px;
  display: flex;
  align-items: flex-start;
  gap: 20px;
  box-sizing: border-box;
  font-family: 'Segoe UI', 'PingFang SC', 'Microsoft YaHei', sans-serif;
  color: #12212f;
}

.panel {
  border: 1px solid #d9e3ed;
  border-radius: 8px;
  padding: 18px;
  background: linear-gradient(180deg, #ffffff 0%, #f5f8fb 100%);
  box-shadow: 0 10px 24px rgb(36 67 96 / 8%);
}

.panel--controls {
  flex: 0 0 360px;
  display: flex;
  flex-direction: column;
}

.panel--video {
  flex: 1 1 auto;
  min-width: 0;
}

.video-wrapper {
  margin: 0 auto;
  width: min(1080px, 100%);
  overflow: hidden;
  border-radius: 8px;
  background: #05080c;
}

.player {
  display: block;
  width: 100%;
  aspect-ratio: 16 / 10;
  height: auto;
  object-fit: contain;
}

.title {
  margin: 0;
  font-size: 22px;
  line-height: 1.25;
}

.hint {
  margin: 12px 0 0;
  color: #4c6478;
}

.grid {
  display: grid;
  gap: 10px;
  margin-top: 30px;
}

.field {
  display: grid;
  gap: 6px;
}

.field-label {
  font-size: 14px;
  font-weight: 600;
  color: #25455e;
}

.input {
  width: 100%;
  box-sizing: border-box;
  border: 1px solid #b8c8d6;
  border-radius: 8px;
  padding: 10px 12px;
  font-size: 14px;
  color: #10293e;
  background: #fff;
}

.input:focus {
  border-color: #0b7d72;
  outline: 3px solid rgb(11 125 114 / 14%);
}

.actions {
  margin-top: 26px;
  display: flex;
  gap: 10px;
  flex-wrap: wrap;
}

.button {
  border: 0;
  border-radius: 8px;
  padding: 10px 16px;
  background: #0b7d72;
  color: #fff;
  cursor: pointer;
}

.button--secondary {
  background: #6f8798;
}

.button:disabled {
  opacity: 0.5;
  cursor: not-allowed;
}

.status {
  margin-top: 24px;
  margin-bottom: 0;
  color: #2b475c;
  word-break: break-all;
}

@media (max-width: 768px) {
  .page {
    padding: 16px;
    flex-direction: column;
  }

  .panel {
    width: 100%;
    box-sizing: border-box;
  }

  .panel--controls {
    flex-basis: auto;
  }
}
</style>
