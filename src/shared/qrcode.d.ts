declare module 'qrcode' {
  const QRCode: {
    toCanvas(canvas: HTMLCanvasElement, text: string, options?: { width?: number; margin?: number; errorCorrectionLevel?: 'L' | 'M' | 'Q' | 'H' }): Promise<void>;
    create(text: string, options?: { errorCorrectionLevel?: 'L' | 'M' | 'Q' | 'H' }): { modules: { size: number; data: Uint8Array } };
  };
  export default QRCode;
}
