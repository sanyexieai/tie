import {
  DeleteObjectCommand,
  GetObjectCommand,
  ListObjectsV2Command,
  PutObjectCommand,
  S3Client,
} from '@aws-sdk/client-s3'
import { indexEntryFromMeta, normalizeFileMeta, resourceFromMeta, sanitizeBlobName, sanitizeFileId } from './workspace-files.js'

const PAGE_PREFIX = 'tie/pages/'
const HISTORY_PREFIX = 'tie/history/'
const ASSET_PREFIX = 'tie/assets/'
const FILES_PREFIX = 'tie/files/'

function streamToBuffer(stream) {
  return new Promise((resolve, reject) => {
    const chunks = []
    stream.on('data', (chunk) => chunks.push(chunk))
    stream.on('error', reject)
    stream.on('end', () => resolve(Buffer.concat(chunks)))
  })
}

function streamToString(stream) {
  return streamToBuffer(stream).then((buffer) => buffer.toString('utf8'))
}

export function createS3Client(publicConfig, credentials) {
  const endpoint = String(publicConfig.endpoint ?? '').trim()
  const region = String(publicConfig.region ?? 'us-east-1').trim() || 'us-east-1'
  return new S3Client({
    region,
    endpoint,
    forcePathStyle: true,
    credentials: {
      accessKeyId: credentials.accessKey,
      secretAccessKey: credentials.secretKey,
    },
  })
}

export function pageObjectKey(pageId) {
  return `${PAGE_PREFIX}${pageId}.md`
}

export function historyPrefix(pageId) {
  return `${HISTORY_PREFIX}${pageId}/`
}

export function assetObjectKey(pageId, assetName) {
  return `${ASSET_PREFIX}${pageId}/${assetName}`
}

export function assetPrefix(pageId) {
  return `${ASSET_PREFIX}${pageId}/`
}

export async function listProviderPageIds(client, bucket) {
  const ids = []
  let token
  do {
    const response = await client.send(new ListObjectsV2Command({
      Bucket: bucket,
      Prefix: PAGE_PREFIX,
      ContinuationToken: token,
    }))
    for (const item of response.Contents ?? []) {
      const key = item.Key ?? ''
      if (key.endsWith('.md')) {
        ids.push(key.slice(PAGE_PREFIX.length, -3))
      }
    }
    token = response.IsTruncated ? response.NextContinuationToken : undefined
  } while (token)
  return ids
}

export async function getProviderPage(client, bucket, pageId) {
  const response = await client.send(new GetObjectCommand({ Bucket: bucket, Key: pageObjectKey(pageId) }))
  return streamToString(response.Body)
}

export async function putProviderPage(client, bucket, page) {
  const { frontmatter } = await import('./page-format.js')
  await client.send(new PutObjectCommand({
    Bucket: bucket,
    Key: pageObjectKey(page.id),
    Body: frontmatter(page),
    ContentType: 'text/markdown; charset=utf-8',
  }))
}

export async function deleteProviderPages(client, bucket, pageIds) {
  for (const pageId of pageIds) {
    await client.send(new DeleteObjectCommand({ Bucket: bucket, Key: pageObjectKey(pageId) }))
    for (const prefix of [historyPrefix(pageId), assetPrefix(pageId)]) {
      let token
      do {
        const response = await client.send(new ListObjectsV2Command({
          Bucket: bucket,
          Prefix: prefix,
          ContinuationToken: token,
        }))
        for (const item of response.Contents ?? []) {
          if (item.Key) {
            await client.send(new DeleteObjectCommand({ Bucket: bucket, Key: item.Key }))
          }
        }
        token = response.IsTruncated ? response.NextContinuationToken : undefined
      } while (token)
    }
  }
}

export async function listProviderRevisions(client, bucket, pageId) {
  const revisions = []
  let token
  do {
    const response = await client.send(new ListObjectsV2Command({
      Bucket: bucket,
      Prefix: historyPrefix(pageId),
      ContinuationToken: token,
    }))
    for (const item of response.Contents ?? []) {
      const key = item.Key ?? ''
      if (!key.endsWith('.md')) continue
      const revisionId = key.slice(historyPrefix(pageId).length, -3)
      const content = await streamToString((await client.send(new GetObjectCommand({ Bucket: bucket, Key: key }))).Body)
      const { parsePage } = await import('./page-format.js')
      const page = parsePage(content)
      revisions.push({ id: revisionId, savedAt: page.updatedAt, title: page.title })
    }
    token = response.IsTruncated ? response.NextContinuationToken : undefined
  } while (token)
  return revisions.sort((a, b) => b.savedAt.localeCompare(a.savedAt))
}

export async function getProviderRevision(client, bucket, pageId, revisionId) {
  const key = `${historyPrefix(pageId)}${revisionId}.md`
  const content = await streamToString((await client.send(new GetObjectCommand({ Bucket: bucket, Key: key }))).Body)
  return content
}

export async function archiveProviderRevision(client, bucket, page) {
  const { frontmatter, revisionId } = await import('./page-format.js')
  const id = revisionId()
  await client.send(new PutObjectCommand({
    Bucket: bucket,
    Key: `${historyPrefix(page.id)}${id}.md`,
    Body: frontmatter(page),
    ContentType: 'text/markdown; charset=utf-8',
  }))
}

export async function putProviderAsset(client, bucket, pageId, assetName, data, contentType) {
  await client.send(new PutObjectCommand({
    Bucket: bucket,
    Key: assetObjectKey(pageId, assetName),
    Body: data,
    ContentType: contentType,
  }))
}

export async function getProviderAsset(client, bucket, pageId, assetName) {
  const response = await client.send(new GetObjectCommand({
    Bucket: bucket,
    Key: assetObjectKey(pageId, assetName),
  }))
  return streamToBuffer(response.Body)
}

export async function listProviderAssetNames(client, bucket, pageId) {
  const prefix = assetPrefix(pageId)
  const names = []
  let token
  do {
    const response = await client.send(new ListObjectsV2Command({
      Bucket: bucket,
      Prefix: prefix,
      ContinuationToken: token,
    }))
    for (const item of response.Contents ?? []) {
      const key = item.Key ?? ''
      if (!key.startsWith(prefix) || key === prefix) continue
      names.push(key.slice(prefix.length))
    }
    token = response.IsTruncated ? response.NextContinuationToken : undefined
  } while (token)
  return names
}

function filesIndexKey() {
  return `${FILES_PREFIX}index.json`
}

function fileMetaKey(fileId) {
  return `${FILES_PREFIX}${fileId}/meta.json`
}

function fileBlobKey(fileId, blobName) {
  return `${FILES_PREFIX}${fileId}/${blobName}`
}

async function getJson(client, bucket, key) {
  try {
    const response = await client.send(new GetObjectCommand({ Bucket: bucket, Key: key }))
    return JSON.parse(await streamToString(response.Body))
  } catch (error) {
    if (error?.name === 'NoSuchKey' || String(error?.message ?? '').includes('NoSuchKey')) return null
    throw error
  }
}

async function putJson(client, bucket, key, value) {
  await client.send(new PutObjectCommand({
    Bucket: bucket,
    Key: key,
    Body: `${JSON.stringify(value, null, 2)}\n`,
    ContentType: 'application/json; charset=utf-8',
  }))
}

async function listKeys(client, bucket, prefix) {
  const keys = []
  let token
  do {
    const response = await client.send(new ListObjectsV2Command({
      Bucket: bucket,
      Prefix: prefix,
      ContinuationToken: token,
    }))
    for (const item of response.Contents ?? []) {
      if (item.Key) keys.push(item.Key)
    }
    token = response.IsTruncated ? response.NextContinuationToken : undefined
  } while (token)
  return keys
}

export async function listProviderFiles(client, bucket) {
  const index = await getJson(client, bucket, filesIndexKey())
  const entries = Array.isArray(index) ? index : []
  const files = []
  for (const entry of entries) {
    const id = String(entry?.id || '')
    try { sanitizeFileId(id) } catch { continue }
    const meta = await getJson(client, bucket, fileMetaKey(id))
    if (!meta) continue
    const keys = meta.mode === 'copy' ? await listKeys(client, bucket, `${FILES_PREFIX}${id}/`) : []
    files.push(resourceFromMeta(meta, {
      exists: meta.mode === 'copy' && keys.some((key) => !key.endsWith('meta.json')),
    }))
  }
  return files.filter(Boolean)
}

export async function getProviderFile(client, bucket, fileId) {
  const id = sanitizeFileId(fileId)
  const meta = await getJson(client, bucket, fileMetaKey(id))
  if (!meta) {
    const error = new Error('文件资源不存在')
    error.status = 404
    throw error
  }
  const keys = meta.mode === 'copy' ? await listKeys(client, bucket, `${FILES_PREFIX}${id}/`) : []
  return resourceFromMeta(meta, {
    exists: meta.mode === 'copy' && keys.some((key) => !key.endsWith('meta.json')),
  })
}

export async function upsertProviderFileMeta(client, bucket, raw) {
  const id = sanitizeFileId(raw.id)
  const now = new Date().toISOString()
  const meta = normalizeFileMeta({ ...raw, id }, { now })
  await putJson(client, bucket, fileMetaKey(id), meta)
  const index = await getJson(client, bucket, filesIndexKey())
  const entries = Array.isArray(index) ? index.filter((item) => item.id !== id) : []
  entries.unshift(indexEntryFromMeta(meta))
  await putJson(client, bucket, filesIndexKey(), entries)
  return getProviderFile(client, bucket, id)
}

export async function putProviderFileBlob(client, bucket, fileId, blobName, data) {
  const id = sanitizeFileId(fileId)
  const name = sanitizeBlobName(blobName)
  if (!data?.length) {
    const error = new Error('导入内容为空')
    error.status = 400
    throw error
  }
  if (data.length > 20 * 1024 * 1024) {
    const error = new Error('远程导入不能超过 20 MB，请改用登记或缩小文件')
    error.status = 413
    throw error
  }
  await client.send(new PutObjectCommand({
    Bucket: bucket,
    Key: fileBlobKey(id, name),
    Body: data,
    ContentType: 'application/octet-stream',
  }))
  return name
}

export async function getProviderFileBlob(client, bucket, fileId) {
  const id = sanitizeFileId(fileId)
  const keys = await listKeys(client, bucket, `${FILES_PREFIX}${id}/`)
  const blobKey = keys.find((key) => !key.endsWith('meta.json'))
  if (!blobKey) {
    const error = new Error('副本缺失')
    error.status = 404
    throw error
  }
  const response = await client.send(new GetObjectCommand({ Bucket: bucket, Key: blobKey }))
  return streamToBuffer(response.Body)
}
