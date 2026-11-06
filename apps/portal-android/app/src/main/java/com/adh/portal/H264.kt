package com.adh.portal

import java.nio.ByteBuffer

/** Annex-B 工具：切 NAL、生成 avcC、转 AVCC 长度前缀。 */
object H264 {
    const val NAL_SLICE = 1
    const val NAL_IDR = 5
    const val NAL_SPS = 7
    const val NAL_PPS = 8

    data class Config(
        val sps: ByteArray,
        val pps: ByteArray,
        val description: ByteArray,
        val codec: String,
    )

    /** 返回去掉起始码的 NAL 列表。 */
    fun splitNals(data: ByteArray): List<ByteArray> {
        val nals = mutableListOf<ByteArray>()
        var offset = 0
        while (true) {
            val start = findStartCode(data, offset) ?: break
            val bodyStart = start.second
            val next = findStartCode(data, bodyStart)
            if (next == null) {
                nals.add(data.copyOfRange(bodyStart, data.size))
                break
            }
            nals.add(data.copyOfRange(bodyStart, next.first))
            offset = next.first
        }
        return nals
    }

    private fun findStartCode(data: ByteArray, from: Int): Pair<Int, Int>? {
        var i = from
        while (i + 3 < data.size) {
            if (data[i].toInt() == 0 && data[i + 1].toInt() == 0) {
                if (data[i + 2].toInt() == 1) return i to (i + 3)
                if (data[i + 2].toInt() == 0 && data[i + 3].toInt() == 1) return i to (i + 4)
            }
            i++
        }
        return null
    }

    fun nalType(nal: ByteArray): Int = if (nal.isEmpty()) 0 else nal[0].toInt() and 0x1f

    fun buildConfig(nals: List<ByteArray>): Config? {
        val sps = nals.firstOrNull { nalType(it) == NAL_SPS } ?: return null
        val pps = nals.firstOrNull { nalType(it) == NAL_PPS } ?: return null
        val description = buildAvcC(sps, pps) ?: return null
        return Config(sps, pps, description, codecString(sps))
    }

    fun buildAvcC(sps: ByteArray, pps: ByteArray): ByteArray? {
        if (sps.size < 4 || pps.isEmpty()) return null
        val out = ByteArray(11 + sps.size + pps.size)
        var i = 0
        out[i++] = 1
        out[i++] = sps[1]
        out[i++] = sps[2]
        out[i++] = sps[3]
        out[i++] = 0xff.toByte()
        out[i++] = 0xe1.toByte()
        out[i++] = ((sps.size shr 8) and 0xff).toByte()
        out[i++] = (sps.size and 0xff).toByte()
        sps.copyInto(out, i)
        i += sps.size
        out[i++] = 1
        out[i++] = ((pps.size shr 8) and 0xff).toByte()
        out[i++] = (pps.size and 0xff).toByte()
        pps.copyInto(out, i)
        return out
    }

    fun codecString(sps: ByteArray): String {
        fun hex(value: Byte): String = "%02x".format(value.toInt() and 0xff)
        return "avc1.${hex(sps[1])}${hex(sps[2])}${hex(sps[3])}"
    }

    /** NAL 列表 → AVCC（每个 NAL 前加 4 字节大端长度）。 */
    fun nalsToAvcc(nals: List<ByteArray>): ByteArray {
        var size = 0
        for (nal in nals) size += 4 + nal.size
        val out = ByteArray(size)
        var offset = 0
        for (nal in nals) {
            val length = nal.size
            out[offset++] = ((length ushr 24) and 0xff).toByte()
            out[offset++] = ((length ushr 16) and 0xff).toByte()
            out[offset++] = ((length ushr 8) and 0xff).toByte()
            out[offset++] = (length and 0xff).toByte()
            nal.copyInto(out, offset)
            offset += length
        }
        return out
    }

    fun isKeyFrame(nals: List<ByteArray>): Boolean = nals.any { nalType(it) == NAL_IDR }

    fun bytesOf(buffer: ByteBuffer): ByteArray {
        val copy = buffer.duplicate()
        val out = ByteArray(copy.remaining())
        copy.get(out)
        return out
    }
}
