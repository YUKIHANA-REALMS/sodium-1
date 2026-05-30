import axios from 'axios';
import FormData from 'form-data';
import logger from '../../logger';

const INDICLOUD_URL = 'https://api.indicloud.xyz';

export class IndiCloudClient {
  private apiKey: string;

  constructor(apiKey: string) {
    this.apiKey = apiKey;
  }

  async uploadFile(fileStream: any, fileName: string) {
    const form = new FormData();
    form.append('file', fileStream, fileName);

    try {
      const response = await axios.post(`${INDICLOUD_URL}/storage/upload`, form, {
        headers: {
          ...form.getHeaders(),
          'X-API-Key': this.apiKey,
        },
        maxContentLength: Infinity,
        maxBodyLength: Infinity,
      });

      return response.data;
    } catch (error) {
      logger.error('IndiCloud upload error:', error);
      throw error;
    }
  }

  async deleteFile(fileId: string) {
    try {
      const response = await axios.delete(`${INDICLOUD_URL}/storage/files/${fileId}`, {
        headers: {
          'X-API-Key': this.apiKey,
        },
      });

      return response.data;
    } catch (error) {
      logger.error('IndiCloud delete error:', error);
      throw error;
    }
  }

  async getDownloadStream(fileId: string) {
    try {
      const response = await axios.get(`${INDICLOUD_URL}/storage/download/${fileId}`, {
        headers: {
          'X-API-Key': this.apiKey,
        },
        responseType: 'stream',
      });

      return response;
    } catch (error) {
      logger.error('IndiCloud download error:', error);
      throw error;
    }
  }
}
