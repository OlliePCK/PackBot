const db = require('../database/db.js');
const { request } = require('undici');

module.exports = client => {
    async function fetch_channels_to_check() {
        return await db.pool.query('SELECT DISTINCT channelId FROM Youtube');
    }

    async function fetch_latest_video(channelId) {
        const response = await request(`https://www.googleapis.com/youtube/v3/search?part=snippet&channelId=${channelId}&order=date&maxResults=1&key=${process.env.YOUTUBE_API_KEY}`);
        const video = await response.body.json();
        if (video.items) {
            return video.items[0].id.videoId;
        } else return null;
    }

    function checkChannels() {
        fetch_channels_to_check().then(([rows]) => {
            for (const row of rows) {
                fetch_latest_video(row.channelId).then(videoId => {
                    if (!videoId) return;
                    console.log(videoId);
                }).catch(console.error);
            }
        }).catch(console.error);
    }
    checkChannels();
};

/*{
  "kind": "youtube#searchListResponse",
  "etag": "G2FUGoicTDrbv9VZr2am_GFK8YU",
  "nextPageToken": "CAEQAA",
  "regionCode": "AU",
  "pageInfo": {
    "totalResults": 73,
    "resultsPerPage": 1
  },
  "items": [
    {
      "kind": "youtube#searchResult",
      "etag": "yTHkYmdAmCUS247Ch-57Fy-Mklk",
      "id": {
        "kind": "youtube#video",
        "videoId": "uwaF5C4UmFA"
      },
      "snippet": {
        "publishedAt": "2022-11-03T13:11:04Z",
        "channelId": "UC70pRFE3xrszmBfxI145UCg",
        "title": "She Made Him BARK &amp; This Happened.. 😳",
        "description": "omegle #funny #shorts.",
        "thumbnails": {
          "default": {
            "url": "https://i.ytimg.com/vi/uwaF5C4UmFA/default.jpg",
            "width": 120,
            "height": 90
          },
          "medium": {
            "url": "https://i.ytimg.com/vi/uwaF5C4UmFA/mqdefault.jpg",
            "width": 320,
            "height": 180
          },
          "high": {
            "url": "https://i.ytimg.com/vi/uwaF5C4UmFA/hqdefault.jpg",
            "width": 480,
            "height": 360
          }
        },
        "channelTitle": "OlliePCK",
        "liveBroadcastContent": "none",
        "publishTime": "2022-11-03T13:11:04Z"
      }
    }
  ]
}
*/