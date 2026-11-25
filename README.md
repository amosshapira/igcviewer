# IGC Parser + 3D Flight Viewer

![Alt text](viewer.jpg?raw=true "Title")

This project includes:
- A Go parser for `.igc` flight logs
- A local web server with API endpoints
- A browser frontend that renders the flight route on 3D terrain (+ replay)

## Run

```bash
 ./igcviewer
```

Then open:

`http://localhost:8080`

Upload an `.igc` file in the page header and click `Upload`.

## API

- `POST /api/flight` -> upload and parse IGC file

Multipart form field name:
- `igc` (the uploaded `.igc` file)

- `GET /api/flight?flight=<id>` -> fetch and parse the IGC file of a flight

Only available when the binary is built with the `flugbuech` build tag
(`go build -tags flugbuech`). Fetches the IGC file of the flight with the
given ID from the flugbuech instance configured using `IGCVIEWER_UPSTREAM`,
authenticating with the token configured using `IGCVIEWER_TOKEN`.

## Configuration

- `IGCVIEWER_ADDR`: address to listen on (default: `localhost:8080`)
- `IGCVIEWER_UPSTREAM`: base URL of the flugbuech instance to fetch flights
  from (default: disabled)
- `IGCVIEWER_TOKEN`: access token sent to the flugbuech API when fetching
  flights (default: empty)

# Credits

- Replay marker: the paraglider option is the original upstream SVG
  marker; the glider option is a top-down silhouette drawn for this
  project. The favicon (GPS-tracking icon: map, pin, dashed track) was
  recreated in this project as a clean SVG — the visual concept is common
  in navigation icon sets.

# External resources

For rendering the map, several external sources are used/loaded:

## DEM files:

https://github.com/tilezen/joerd/ (https://s3.amazonaws.com/elevation-tiles-prod/)

## Map tiles

https://tile.openstreetmap.org/

## Satellite raster

https://server.arcgisonline.com/ArcGIS/rest/services/World_Imagery/MapServer/tile/

## JS

 MapLibre + deck.gl from unpkg.com
