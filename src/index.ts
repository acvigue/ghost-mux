import Mux from '@mux/mux-node';
import StorageBase, { type ReadOptions, type Image } from 'ghost-storage-base'
import { createReadStream } from 'fs'
import { request, type Handler } from 'express'

const stripLeadingSlash = (s: string) =>
  s.indexOf('/') === 0 ? s.substring(1) : s
const stripEndingSlash = (s: string) =>
  s.indexOf('/') === s.length - 1 ? s.substring(0, s.length - 1) : s

type EncodingTier = 'baseline' | 'smart'

type Config = {
  tokenId?: string
  tokenSecret?: string
  encodingTier?: EncodingTier
}

const videoThumbnailMap = {}


async function* nodeStreamToIterator(stream) {
  for await (const chunk of stream) {
    yield chunk;
  }
}

/**
 * Taken from Next.js doc
 * https://nextjs.org/docs/app/building-your-application/routing/router-handlers#streaming
 * Itself taken from mozilla doc
 * https://developer.mozilla.org/en-US/docs/Web/API/ReadableStream#convert_async_iterator_to_stream
 * @param {*} iterator 
 * @returns {ReadableStream}
 */
function iteratorToStream(iterator) {
  return new ReadableStream({
    async pull(controller) {
      const { value, done } = await iterator.next()

      if (done) {
        controller.close()
      } else {

        controller.enqueue(new Uint8Array(value))
      }
    },
  })
}


class MuxStorage extends StorageBase {
  tokenId?: string
  tokenSecret?: string
  encodingTier?: EncodingTier

  constructor(config: Config = {}) {
    super()

    const {
      tokenId,
      tokenSecret,
      encodingTier = 'smart',
    } = config

    // Compatible with the aws-sdk's default environment variables
    this.tokenId = tokenId
    this.tokenSecret = tokenSecret
    this.encodingTier = process.env.ENCODING_TIER as EncodingTier || encodingTier

    if (!this.tokenId) throw new Error('No Mux Token ID provided')
    if (!this.tokenSecret) throw new Error('No Mux Token Secret provided')
  }

  async delete(fileName: string, targetDir?: string) {
    return true;
  }

  async exists(fileName: string, targetDir?: string) {
    return false;
  }

  mux() {
    return new Mux({
      tokenId: this.tokenId,
      tokenSecret: this.tokenSecret
    });
  }

  // Doesn't seem to be documented, but required for using this adapter for other media file types.
  // Seealso: https://github.com/laosb/ghos3/pull/6
  urlToPath(url: string) {
    const parsedUrl = new URL(url)
    return parsedUrl.pathname
  }

  async save(image: Image, targetDir?: string) {
    if (image.type.indexOf('video/') !== 0) {
      //return original assetID
      const assetID = image.name.split('_').shift()
      return `https://vigue.me/api/muxThumbnail/${assetID}`
    }

    const file = createReadStream(image.path)

    const mux = this.mux()

    const upload = await mux.video.uploads.create({
      cors_origin: 'https://cms.vigue.me',
      new_asset_settings: {
        playback_policy: ['public'],
        encoding_tier: this.encodingTier
      }
    })

    console.log(`Upload ${upload.id} created: ${upload.url}`)

    const iterator = nodeStreamToIterator(file)
    const webStream = iteratorToStream(iterator)

    //put the file into the upload
    const response = await fetch(upload.url, {
      method: 'PUT',
      body: webStream,
      headers: {
        'Content-Type': image.type
      },
      //@ts-expect-error
      duplex: "half"
    })

    console.log(response.status)

    console.log(`Upload ${upload.id} completed`)

    const result = await mux.video.uploads.retrieve(upload.id);
    const assetID = result.asset_id;

    console.log(`Asset ID: ${assetID}`)

    if (!assetID) {
      throw new Error('No asset ID found')
    }

    return `https://vigue.me/api/muxManifest/${assetID}`;
  }

  serve(): Handler {
    return async (req, res, next) => {
      res.status(404)
    }
  }

  async read(options: ReadOptions = { path: '' }) {
    throw new Error(`${options.path} not readable`);
    return Buffer.from('');
  }
}

export default MuxStorage
