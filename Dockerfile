FROM node:14-alpine
RUN apk add tesseract-ocr dumb-init
ENV NODE_ENV production
ENV TESSDATA_PREFIX /app
ENV PORT 3000
EXPOSE 3000

WORKDIR /app

COPY package.json package-lock.json ./
RUN npm ci --only=production

COPY index.js digits.traineddata ./
CMD ["dumb-init", "npm", "start"]
