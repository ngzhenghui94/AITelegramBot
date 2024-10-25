// ES6 version using arrow function and object destructuring

export default (req, res) => {
  const { body, query, cookies } = req;
  res.json({ body, query, cookies });
};