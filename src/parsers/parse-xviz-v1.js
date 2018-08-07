import {getXvizConfig} from '../config/xviz-config';
import {filterVertices} from './filter-vertices';

const PRIMITIVE_CAT = {
  lookAheads: 'lookAheads',
  features: 'features',
  labels: 'labels',
  pointCloud: 'pointCloud',
  components: 'components'
};

const PRIMITIVE_CATEGORY_LOOKUP = {
  text: PRIMITIVE_CAT.labels,
  tree_table: PRIMITIVE_CAT.components,
  points3d: PRIMITIVE_CAT.pointCloud,
  point2d: PRIMITIVE_CAT.features,
  points2d: PRIMITIVE_CAT.features,
  line2d: PRIMITIVE_CAT.features,
  polygon2d: PRIMITIVE_CAT.features,
  circle: PRIMITIVE_CAT.features,
  circle2d: PRIMITIVE_CAT.features
};

// Handle stream-sliced data, via the ETL flow.
export function parseXvizV1(data, convertPrimitive) {
  // data is an array of objects
  // Each object is [{primitives, variables, timestamp},...]
  // Each object represents a timestamp and array of objects

  const {primitives, variables, futures} = data[0];
  // At this point, we either have one or the other.
  // TODO(twojtasz): BUG: there is an assumption that
  // streamNames will be unique.  Need to put in a detection if
  // that is violated.
  if (primitives) {
    const streamName = Object.keys(primitives)[0];
    return data.map(datum =>
      parseStreamPrimitive(
        datum.primitives[streamName],
        streamName,
        datum.timestamp,
        convertPrimitive
      )
    );
  } else if (variables) {
    const streamName = Object.keys(variables)[0];
    return data.map(datum =>
      parseStreamVariable(datum.variables[streamName], streamName, datum.timestamp)
    );
  } else if (futures) {
    const streamName = Object.keys(futures)[0];
    return data.map(datum =>
      parseStreamFutures(datum.futures[streamName], streamName, datum.timestamp, convertPrimitive)
    );
  }

  return {};
}

/* eslint-disable max-depth, max-statements */

/* Processes an individual primitive time sample and converts the
 * data to UI elements.
 */
export function parseStreamPrimitive(objects, streamName, time, convertPrimitive) {
  const {observeObjects} = getXvizConfig();

  if (!Array.isArray(objects)) {
    return {};
  }

  observeObjects(streamName, objects, time);
  const primitiveMap = Object.keys(PRIMITIVE_CAT).reduce((res, cat) => {
    res[cat] = [];
    return res;
  }, {});

  let category = null;
  // Primitives are an array of XVIZ objects
  for (let objectIndex = 0; objectIndex < objects.length; objectIndex++) {
    const object = objects[objectIndex];

    // array of primitives
    if (object && Array.isArray(object)) {
      category = PRIMITIVE_CAT.lookAheads;
      primitiveMap[category].push([]);

      for (let j = 0; j < object.length; j++) {
        // Apply custom XVIZ pre processing to this primitive
        getXvizConfig().preProcessPrimitive({primitive: object[j], streamName, time});

        // process each primitive
        const primitive = normalizeXvizPrimitive(
          object[j],
          objectIndex,
          streamName,
          time,
          convertPrimitive
        );
        if (primitive) {
          primitiveMap[category][objectIndex].push(primitive);
        }
      }
    } else {
      // single primitive

      // Apply custom XVIZ postprocessing to this primitive
      getXvizConfig().preProcessPrimitive({primitive: object, streamName, time});

      // process primitive
      category = PRIMITIVE_CATEGORY_LOOKUP[object.type];
      const primitive = normalizeXvizPrimitive(
        object,
        objectIndex,
        streamName,
        time,
        convertPrimitive
      );
      if (primitive) {
        primitiveMap[category].push(primitive);
      }
    }
  }

  primitiveMap.pointCloud = joinObjectPointCloudsToTypedArrays(primitiveMap.pointCloud);
  primitiveMap.time = time;

  return primitiveMap;
}

/* eslint-enable max-depth, max-statements */

/* Processes the futures and converts the
 * data to UI elements.
 */
export function parseStreamFutures(objects, streamName, time, convertPrimitive) {
  const futures = [];
  // objects = array of objects
  // [{timestamp, primitives[]}, ...]

  // Futures are an array of array of primitives
  // TODO(twojtasz): objects indexes represent the
  //     represent an index into time, so they cannot be removed
  //     if empty.
  objects.forEach((object, objectIndex) => {
    const {primitives} = object;

    // TODO(twojtasz): only geometric primitives are supported
    // for now.  Text and point clouds are not handled
    // TODO(twojtasz): addThickness is temporary to use XVIZ thickness
    //                 on polygons.
    const future = primitives
      .map(prim => normalizeXvizPrimitive(prim, objectIndex, streamName, time, convertPrimitive))
      .filter(prim => prim !== null);

    futures.push(future);
  });

  return {
    time,
    lookAheads: futures
  };
}

/* Processes an individual variable time sample and converts the
 * data to UI elements.
 */
export function parseStreamVariable(objects, streamName, time) {
  const isVar = !Array.isArray(objects);
  if (!isVar) {
    return {};
  }

  let variable;
  const {timestamps, values} = objects;
  if (values.length === 1) {
    variable = values[0];
  } else {
    variable = values.map((v, i) => [timestamps[i], v]);
  }

  return {
    time,
    variable
  };
}

// Joins a set of point clouds extracted from objects into a single point cloud
// generates typed arrays that can be displayed efficiently by deck.gl
function joinObjectPointCloudsToTypedArrays(objects) {
  if (objects.length === 0) {
    return null;
  }

  // Assume 3 values (x, y, z) in flattened array
  const countOfValuesPerPointInFlattenedArray = 3;

  let numInstances = 0;
  for (const object of objects) {
    if (object.vertices instanceof Float32Array) {
      numInstances += object.vertices.length / countOfValuesPerPointInFlattenedArray;
    } else {
      numInstances += object.vertices.length;
    }
  }

  const positions = new Float32Array(numInstances * 3);
  const colors = new Uint8ClampedArray(numInstances * 4);
  const normals = new Float32Array(numInstances * 3);

  // Store object ids to enable recoloring.
  // NOTE: Not a vertex attribute, ids are just efficiently stored as as 32 bit integers...
  const ids = new Uint32Array(numInstances);

  objects.forEach(object => {
    let vertexCount = object.vertices.length;
    const isFloat32Array = object.vertices instanceof Float32Array;
    if (isFloat32Array) {
      vertexCount /= countOfValuesPerPointInFlattenedArray;
    }

    for (let i = 0; i < vertexCount; i++) {
      let vertex = object.vertices[i];

      if (isFloat32Array) {
        vertex = [];
        vertex[0] = object.vertices[i * 3 + 0];
        vertex[1] = object.vertices[i * 3 + 1];
        vertex[2] = object.vertices[i * 3 + 2];
      }

      ids[i] = object.id;

      positions[i * 3 + 0] = vertex[0];
      positions[i * 3 + 1] = vertex[1];
      positions[i * 3 + 2] = vertex[2];

      colors[i * 4 + 0] = object.color[0];
      colors[i * 4 + 1] = object.color[1];
      colors[i * 4 + 2] = object.color[2];
      colors[i * 4 + 3] = object.color[3] || 255;

      normals[i * 3 + 0] = 0;
      normals[i * 3 + 1] = 1;
      normals[i * 3 + 2] = 0;
    }
  });

  return {
    // track type so we can handle 2d & 3d clouds
    type: objects[0].type,
    numInstances,
    positions,
    colors,
    normals,
    ids
  };
}

const PRIMITIVE_PROCCESSOR = {
  text: {
    validate: _ => true
  },
  tree_table: {
    validate: _ => true
  },
  points3d: {
    validate: (primitive, streamName, time) => primitive.vertices && primitive.vertices.length > 0
  },
  points2d: {
    validate: (primitive, streamName, time) => primitive.vertices && primitive.vertices.length > 0,
    normalize: primitive => {
      for (let i = 0; i < primitive.vertices.length; i++) {
        primitive.vertices[i][2] = 0;
      }
    }
  },
  point2d: {
    enableZOffSet: true,
    validate: (primitive, streamName, time) =>
      primitive.vertices && primitive.vertices.length === 1,
    normalize: primitive => {
      primitive.vertices = primitive.vertices[0];
    }
  },
  line2d: {
    enableZOffset: true,
    validate: (primitive, streamName, time) =>
      primitive.vertices &&
      primitive.vertices.length >= 2 &&
      streamName !== '/route_follower/kickout/object/velocity',
    normalize: primitive => {
      // Filter out identical vertices to make sure we don't get rendering artifacts
      // in the path layer
      // TODO - handle this directly in deck.gl PathLayer
      primitive.vertices = filterVertices(primitive.vertices);
    }
  },
  polygon2d: {
    enableZOffset: true,
    validate: (primitive, streamName, time) => primitive.vertices && primitive.vertices.length >= 3,
    normalize: primitive => {
      // This is a polygon2d primitive which per XVIZ protocol implicitly says
      // that the provided path is closed. Push a copy of first vert to end of array.
      // Array comparison turns out to be expensive. Looks like the polygon returned
      // from XVIS is never closed - worst case we end up with a duplicate end vertex,
      // which will not break the polygon layer.
      // TODO - can't handle flat arrays for now
      if (Array.isArray(primitive.vertices)) {
        primitive.vertices.push(primitive.vertices[0]);
      }
    }
  },
  circle: {
    enableZOffset: true,
    validate: (primitive, streamName, time) => primitive.vertices && primitive.vertices.length > 0
  },
  circle2d: {
    enableZOffset: true,
    validate: (primitive, streamName, time) => primitive.center,
    normalize: primitive => {
      primitive.vertices = primitive.center;
    }
  }
};

/* eslint-disable max-depth */
function normalizeXvizPrimitive(primitive, objectIndex, streamName, time, postProcessPrimitive) {
  // as normalizeXvizPrimitive is called for each primitive of every frame
  // it is intentional to mutate the primitive in place
  // to avoid frequent allocate/discard and improve performance

  const {
    // common
    type,
    // line2d, polygon2d
    vertices,
    // circle2d
    center
  } = primitive;

  const {enableZOffset, validate, normalize} = PRIMITIVE_PROCCESSOR[type];

  // Apply a small offset to 2d geometries to battle z fighting
  if (enableZOffset) {
    const zOffset = objectIndex * 1e-6;
    if (Array.isArray(vertices)) {
      // TODO(twojtasz): this is pretty bad for memory, backend must
      // set all 3 values otherwise we allocate and cause heavy GC
      // TODO - this looks like it could be handled with a model matrix?
      for (let i = 0; i < vertices.length; i++) {
        // Flatten the data for now
        vertices[i][2] = zOffset;
      }
    }
    if (center && center.length === 2) {
      center[2] = zOffset;
    }
  }

  // validate
  if (!validate(primitive, streamName, time)) {
    return null;
  }

  // process
  if (normalize) {
    normalize(primitive);
  }

  // post process
  if (postProcessPrimitive) {
    postProcessPrimitive(primitive);
  }

  return primitive;
}
/* eslint-enable max-depth */
